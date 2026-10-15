import { randomUUID } from "node:crypto";
import type { RunCostEstimator } from "../../evaluations/estimate.js";
import { DEFAULT_MAX_QUEUED_RUNS_PER_USER, DEFAULT_RUNS_PER_USER_PER_DAY, round4, type EvaluationsConfig } from "../../evaluations/config.js";
import { parseEvaluationRequest, resolveEvaluationRequest } from "../../evaluations/resolve.js";
import { PlatformQuotaExceededError, QuotaExceededError, TooManyQueuedError, type EvaluationsStore } from "../../evaluations/store.js";
import type { PriceLookup } from "../../domain/model-prices.js";
import { PLATFORM_KEY_OFF, type PlatformKeyConfig } from "../../models/platform-key.js";
import { isModelApiKey } from "../../http/runs-router.js";
import { sealModelApiKey } from "./model-key.js";
import type { AfterGradedContext, PaymentAdapter, PaymentOutcome } from "./types.js";

/**
 * The `free_byok` payment adapter (web2 client, DFL principal; plan 20261015-testmyagent-web2-client,
 * ADR-5, ADR-6, ADR-9, task T7).
 *
 *   quote        a zero quote: no SOL, no payment. An informational US$ model-cost estimate only.
 *   transaction  none: 409 `no_payment`.
 *   abuse        ADR-9: `429 quota_exceeded {resetAt}` over `TMA_RUNS_PER_USER_PER_DAY` runs in 24 h (N tasks = N runs),
 *                `429 too_many_queued` over `TMA_MAX_QUEUED_RUNS_PER_USER`; both checked in the store under the owner's lock.
 *   settle       `POST /evaluations {agentId, taskIds[], modelApiKey, modelRelease?}`: the key is
 *                required and probed (`probeModelKey`), sealed (AES-256-GCM, like the paid path),
 *                and the evaluation + N `queued` runs are written in one transaction → 202.
 *   afterGraded  nothing: a free evaluation ends at `graded`, with no proof.
 */

/**
 * The result of a model key probe. `model_key_invalid` / `model_key_no_credit` are 422 refusals.
 * `model_key_probe_unavailable` (OpenRouter did not answer in time) is a 503 with Retry-After.
 */
export type ModelKeyProbeResult =
  | { ok: true }
  | { ok: false; code: "model_key_invalid" | "model_key_no_credit"; message: string }
  | { ok: false; code: "model_key_probe_unavailable"; message: string; retryAfterSeconds: number };

/**
 * The model key probe seam. T8 fills it with the OpenRouter `GET /api/v1/key` check
 * (`models/openrouter-key.ts`; ADR-5: non-200 → `model_key_invalid`, `limit_remaining` 0 →
 * `model_key_no_credit`). It is called after the format check, so it only receives a well-formed key.
 */
export type ModelKeyProbe = (modelApiKey: string) => Promise<ModelKeyProbeResult>;

/** The default probe until T8: the format check already ran, so every key passes. No network call. */
export const formatOnlyProbe: ModelKeyProbe = async () => ({ ok: true });

/** An OpenRouter API key: `sk-or-` and the plausible-key rule of the paid path. */
export function isOpenRouterKey(value: unknown): value is string {
  return isModelApiKey(value) && value.trim().startsWith("sk-or-");
}

export { DEFAULT_MAX_QUEUED_RUNS_PER_USER };

export interface FreeByokAdapterDeps {
  store: EvaluationsStore;
  config: EvaluationsConfig;
  estimate?: RunCostEstimator;
  runKeySecret?: string;
  probeModelKey?: ModelKeyProbe;
  /** The clock of the daily quota window (ms). Default: `Date.now`. */
  now?: () => number;
  /** ADR-5 platform-key allowance. Default: off (a key is required). */
  platformKey?: PlatformKeyConfig;
  /** OpenRouter list prices: the platform key pays only models at or below the max prompt price. */
  modelPrice?: PriceLookup;
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
  const dailyRunLimit = config.runsPerUserPerDay ?? DEFAULT_RUNS_PER_USER_PER_DAY;
  const clock = deps.now ?? Date.now;
  const platform = deps.platformKey ?? PLATFORM_KEY_OFF;

  /** ADR-5: the platform key pays only a cheap OpenRouter model (list price per prompt token). */
  const platformAllows = async (modelId: string): Promise<boolean> => {
    if (!deps.modelPrice) return false;
    const price = await deps.modelPrice(modelId).catch(() => null);
    return price !== null && price.prompt <= platform.maxPromptUsdPerToken;
  };

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
      // ADR-5: BYOK is required on the free path, unless the platform-key flag is on (off at launch).
      const noKey = body.modelApiKey === undefined || body.modelApiKey === null || body.modelApiKey === "";
      if (noKey && !platform.enabled) {
        return out(422, { error: "modelApiKey (your OpenRouter API key) is required", code: "model_key_required" });
      }
      if (!noKey && !isOpenRouterKey(body.modelApiKey)) {
        return out(422, { error: "modelApiKey is not a valid OpenRouter API key (sk-or-…)", code: "model_key_invalid" });
      }
      if (!deps.runKeySecret) return out(503, { error: "BYOK is not configured on this server (ITERA_RUN_KEY_SECRET)" });
      if (noKey && !platform.key) {
        return out(503, { error: "the platform model key is not configured on this server; send modelApiKey", code: "platform_key_not_configured" });
      }

      const resolved = await resolveEvaluationRequest(store, config, principalId, parsed);
      if (!resolved.ok) return resolved.outcome;
      const { agent, version, tasks } = resolved;

      let runKey: string;
      if (noKey) {
        // The platform path: a cheap model only, then the per-principal daily platform quota (in the store transaction).
        if (!(await platformAllows(agent.model ?? ""))) {
          return out(422, { error: "the platform model key pays only low-cost models; send your own OpenRouter API key (modelApiKey)", code: "platform_model_not_allowed" });
        }
        runKey = platform.key!;
      } else {
        runKey = (body.modelApiKey as string).trim();
        const probed = await probe(runKey);
        if (!probed.ok) {
          // Nothing is written on any probe refusal: no evaluation, no runs.
          if (probed.code === "model_key_probe_unavailable") {
            return { status: 503, body: { error: probed.message, code: probed.code }, headers: { "Retry-After": String(probed.retryAfterSeconds) } };
          }
          return out(422, { error: probed.message, code: probed.code });
        }
      }

      const sealed = sealModelApiKey(runKey, deps.runKeySecret);
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
          dailyRunLimit,
          now: new Date(clock()),
          ...(noKey ? { keySource: "platform" as const, maxPlatformRunsPerDay: platform.runsPerUserPerDay } : {}),
        });
        return out(202, {
          evaluationId: created.evaluationId,
          status: "pending",
          paymentKind: "free_byok",
          runs: created.runIds.map((id, i) => ({ id, taskId: tasks[i]!.taskId, seq: i + 1 })),
        });
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          return out(429, { error: "quota_exceeded", code: "quota_exceeded", resetAt: e.resetAt, limit: e.limit, used: e.used });
        }
        if (e instanceof PlatformQuotaExceededError) {
          return out(429, { error: `you used ${e.used} of ${e.max} platform-paid runs in the last 24 h; send your own OpenRouter API key (modelApiKey)`, code: "platform_quota_exceeded" });
        }
        if (e instanceof TooManyQueuedError) {
          return out(429, { error: `you already have ${e.active} runs queued or running (max ${e.max}); wait for them to finish`, code: "too_many_queued" });
        }
        throw e;
      }
    },

    afterGraded: freeByokAfterGraded,
  };
}
