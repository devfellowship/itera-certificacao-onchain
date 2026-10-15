import { randomUUID } from "node:crypto";
import type { RunCostEstimator } from "../../evaluations/estimate.js";
import { round4, type EvaluationsConfig } from "../../evaluations/config.js";
import { parseEvaluationRequest, resolveEvaluationRequest } from "../../evaluations/resolve.js";
import { TooManyQueuedError, type EvaluationsStore } from "../../evaluations/store.js";
import { isModelApiKey } from "../../http/runs-router.js";
import { sealModelApiKey } from "./model-key.js";
import type { AfterGradedContext, PaymentAdapter, PaymentOutcome } from "./types.js";

/**
 * The `free_byok` payment adapter (web2 client, DFL principal; plan 20261015-testmyagent-web2-client,
 * ADR-5, ADR-6, ADR-9, task T7).
 *
 *   quote        a zero quote: no SOL, no payment. An informational US$ model-cost estimate only.
 *   transaction  none: 409 `no_payment`.
 *   settle       `POST /evaluations {agentId, taskIds[], modelApiKey, modelRelease?}`: the key is
 *                required and probed (`probeModelKey`), sealed (AES-256-GCM, like the paid path),
 *                and the evaluation + N `queued` runs are written in one transaction → 202.
 *   afterGraded  nothing: a free evaluation ends at `graded`, with no proof.
 */

/** The result of a model key probe. `code` is the 422 refusal code. */
export type ModelKeyProbeResult = { ok: true } | { ok: false; code: "model_key_invalid" | "model_key_no_credit"; message: string };

/**
 * The model key probe seam. Task T8 fills it with the OpenRouter `GET /api/v1/key` check (ADR-5:
 * non-200 → `model_key_invalid`, `limit_remaining` 0 → `model_key_no_credit`). It is called after
 * the format check, so it only receives a well-formed key.
 */
export type ModelKeyProbe = (modelApiKey: string) => Promise<ModelKeyProbeResult>;

/** The default probe until T8: the format check already ran, so every key passes. No network call. */
export const formatOnlyProbe: ModelKeyProbe = async () => ({ ok: true });

/** An OpenRouter API key: `sk-or-` and the plausible-key rule of the paid path. */
export function isOpenRouterKey(value: unknown): value is string {
  return isModelApiKey(value) && value.trim().startsWith("sk-or-");
}

/** ADR-9 default: `TMA_MAX_QUEUED_RUNS_PER_USER`. */
export const DEFAULT_MAX_QUEUED_RUNS_PER_USER = 3;

export interface FreeByokAdapterDeps {
  store: EvaluationsStore;
  config: EvaluationsConfig;
  estimate?: RunCostEstimator;
  runKeySecret?: string;
  probeModelKey?: ModelKeyProbe;
}

/** Web2 ends at `graded`: no proof. */
export async function freeByokAfterGraded(_ctx: AfterGradedContext): Promise<void> {}

const out = (status: number, body: unknown): PaymentOutcome => ({ status, body });

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function createFreeByokAdapter(deps: FreeByokAdapterDeps): PaymentAdapter {
  const { store, config } = deps;
  const probe = deps.probeModelKey ?? formatOnlyProbe;
  const maxQueued = config.maxQueuedRunsPerUser ?? DEFAULT_MAX_QUEUED_RUNS_PER_USER;

  return {
    kind: "free_byok",

    quoteGate: () => null,

    async quote({ agent, tasks }) {
      const modelId = agent.model ?? "unknown";
      const perTask = [];
      for (const t of tasks) {
        const est = deps.estimate && t.packId ? await deps.estimate(t.packId, t.packVersion, modelId).catch(() => null) : null;
        perTask.push({ taskId: t.taskId, slug: t.slug, name: t.name, seq: perTask.length + 1, modelCostEstimateUsd: est ? round4(est.costUsd) : null });
      }
      const known = perTask.filter((t) => t.modelCostEstimateUsd !== null);
      return out(200, {
        paymentKind: "free_byok",
        totalUsd: 0,
        totalLamports: 0,
        taskCount: tasks.length,
        // Informational: the user's own model key pays these tokens (BYOK). Null when no estimate exists.
        modelCostEstimateUsd: known.length > 0 ? round4(known.reduce((a, t) => a + t.modelCostEstimateUsd!, 0)) : null,
        modelKeyRequired: true,
        tasks: perTask,
      });
    },

    transaction: async () => out(409, { error: "the free evaluation path has no payment transaction", code: "no_payment" }),

    async settle({ principalId, body: rawBody }) {
      const body = (rawBody ?? {}) as { modelApiKey?: unknown; modelRelease?: unknown };
      const parsed = parseEvaluationRequest(rawBody, config);
      if (!parsed.ok) return parsed.outcome;
      // ADR-5: BYOK is required on the free path (the platform-key flag is off at launch).
      if (body.modelApiKey === undefined || body.modelApiKey === null || body.modelApiKey === "") {
        return out(422, { error: "modelApiKey (your OpenRouter API key) is required", code: "model_key_required" });
      }
      if (!isOpenRouterKey(body.modelApiKey)) {
        return out(422, { error: "modelApiKey is not a valid OpenRouter API key (sk-or-…)", code: "model_key_invalid" });
      }
      if (!deps.runKeySecret) return out(503, { error: "BYOK is not configured on this server (ITERA_RUN_KEY_SECRET)" });

      const resolved = await resolveEvaluationRequest(store, config, principalId, parsed);
      if (!resolved.ok) return resolved.outcome;
      const { agent, version, tasks } = resolved;

      const probed = await probe(body.modelApiKey.trim());
      if (!probed.ok) return out(422, { error: probed.message, code: probed.code });

      const sealed = sealModelApiKey(body.modelApiKey, deps.runKeySecret);
      if (!sealed.ok) return sealed.outcome;
      if (!sealed.modelApiKeyEnc) return out(422, { error: "modelApiKey is required", code: "model_key_required" });

      const evaluationId = randomUUID();
      try {
        const created = await store.createFreeEvaluation({
          evaluationId,
          runIds: tasks.map(() => randomUUID()),
          ownerWallet: principalId,
          shortId: evaluationId.replace(/-/g, "").slice(0, 8),
          agentId: agent.id,
          agentVersionId: version.id,
          agentCommit: version.commitSha,
          modelId: agent.model ?? "unknown",
          modelRelease: isNonEmptyString(body.modelRelease) ? body.modelRelease.trim() : null,
          tasks,
          isPublic: tasks.every((t) => t.isPublic),
          modelApiKeyEnc: sealed.modelApiKeyEnc,
          maxActiveRuns: maxQueued,
        });
        return out(202, {
          evaluationId: created.evaluationId,
          status: "pending",
          paymentKind: "free_byok",
          runs: created.runIds.map((id, i) => ({ id, taskId: tasks[i]!.taskId, seq: i + 1 })),
        });
      } catch (e) {
        if (e instanceof TooManyQueuedError) {
          return out(429, { error: `you already have ${e.active} runs queued or running (max ${e.max}); wait for them to finish`, code: "too_many_queued" });
        }
        throw e;
      }
    },

    afterGraded: freeByokAfterGraded,
  };
}
