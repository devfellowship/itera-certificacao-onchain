import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { digestOf } from "../domain/digest.js";
import type { EvidenceManifest } from "../domain/grader.js";
import type { Repository } from "../domain/repository.js";
import {
  SchemaNotReadyError,
  TERMINAL_STATUSES,
  type AsyncRun,
  type BuildRunStartTx,
  type CriterionResult,
  type ProofIssuer,
  type ProofRecord,
  type RunsStore,
} from "../domain/runs-store.js";
import { encryptRunKey } from "../domain/run-key.js";
import { requireWallet } from "./auth.js";

/** Contract: "per-wallet limit 5 runs/day". The caller pays the model tokens (BYOK, Tainan TG 20935). */
export const RUNS_PER_WALLET_PER_DAY = Number(process.env.ITERA_RUNS_PER_WALLET_PER_DAY ?? 5);
const LIST_LIMIT = 50;

export interface RunsRouterDeps {
  repo: Repository;
  store: RunsStore;
  /** Lane D (apps/api/src/chain/run-start.ts). Absent → `runStartMemo: null`. */
  buildRunStartTx?: BuildRunStartTx;
  /** Lane D. Absent → publish answers 503. */
  proofIssuer?: ProofIssuer;
  /**
   * ITERA_RUN_KEY_SECRET. Seals the caller's model API key (BYOK, Tainan TG 20935: the user pays the
   * model tokens). Absent → POST /runs answers 503.
   */
  runKeySecret?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A plausible API key: printable, no whitespace inside, bounded. The provider validates the rest. */
export function isModelApiKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{20,512}$/.test(value.trim());
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGradedManifest(value: unknown): value is EvidenceManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "scenario_id" in value &&
    "patch_hash" in value &&
    "score" in value &&
    "tests" in value &&
    "patch_scope" in value
  );
}

// ---------------------------------------------------------------------------------------------
// Redaction. A public read must not show hidden-test names or worker filesystem paths.

const TMP_PATH_RE = /(?:\/private)?\/(?:tmp|var\/folders|var\/tmp|run\/user)\/[^\s'"`:,)]*/g;
const WORKSPACE_PATH_RE = /\/(?:workspace|work|home\/[^/\s]+|root)\/[^\s'"`:,)]*/g;
const HIDDEN_TEST_RE = /\b[\w./-]*hidden[\w./-]*/gi;

export function redactText(text: string): string {
  return text.replace(TMP_PATH_RE, "<tmp>").replace(WORKSPACE_PATH_RE, "<path>").replace(HIDDEN_TEST_RE, "<hidden-test>");
}

/** Server-derived criteria. The caller never supplies them. */
export function criteriaFromManifest(m: EvidenceManifest): CriterionResult[] {
  const t = m.tests;
  return [
    { requirement: "Public tests pass after the patch", result: `${t.public_after_patch.passed}/${t.public_after_patch.total}` },
    { requirement: "Hidden tests pass after the patch", result: `${t.hidden.passed}/${t.hidden.total}` },
    {
      requirement: "No regression against the public baseline",
      result: t.public_after_patch.passed >= t.public_baseline.passed ? "pass" : "fail",
    },
    { requirement: "Patch stays inside the allowed scope", result: m.patch_scope.allowed ? "pass" : "fail" },
    { requirement: "Score total", result: `${m.score.total}/100` },
  ];
}

function proofView(proof: ProofRecord | null) {
  if (!proof) return null;
  return {
    status: proof.status,
    nftMint: proof.nftMint,
    txSig: proof.txSig,
    proofHash: proof.manifestSha256,
    error: proof.error ? redactText(proof.error) : null,
  };
}

function summaryView(run: AsyncRun) {
  return {
    runId: run.id,
    status: run.status,
    phase: run.phase,
    scoreTotal: run.scoreTotal,
    benchmark: { id: run.taskPackId, version: run.taskPackVersion },
    agentId: run.agentId,
    agentVersionId: run.agentVersionId,
    createdAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

async function detailView(store: RunsStore, run: AsyncRun) {
  const manifest = isGradedManifest(run.evidenceManifest) ? run.evidenceManifest : null;
  const [patch, actionsCount, proof] = await Promise.all([store.getPatch(run.id), store.countActions(run.id), store.getProof(run.id)]);
  const errors: string[] = [];
  if (manifest) errors.push(...manifest.errors);
  else if (run.evidenceManifest && typeof run.evidenceManifest === "object" && "error" in run.evidenceManifest) {
    errors.push(String((run.evidenceManifest as { error: unknown }).error));
  }
  if (run.error) errors.push(run.error);
  let parts: Record<string, number> | null = null;
  if (manifest) {
    const { total: _total, ...rest } = manifest.score;
    parts = rest;
  }
  return {
    ...summaryView(run),
    ownerWallet: run.ownerWallet,
    runStartSig: run.runStartSig,
    score: { parts },
    tests: manifest
      ? {
          public: manifest.tests.public_after_patch,
          publicBaseline: manifest.tests.public_baseline,
          // Counts only. Hidden test names never leave the worker.
          hidden: { total: manifest.tests.hidden.total, passed: manifest.tests.hidden.passed, failed: manifest.tests.hidden.failed },
        }
      : null,
    patchScope: manifest ? { changedFiles: manifest.patch_scope.changed_files, allowed: manifest.patch_scope.allowed } : null,
    patch,
    actionsCount,
    errors: errors.map(redactText),
    proof: proofView(proof),
  };
}

/**
 * POST /runs · GET /runs/:id · GET /runs?mine=1 · POST /runs/:id/publish — the async, wallet-owned
 * run flow (contract "Job protocol"). The worker (lane B) executes queued runs; this router only
 * enqueues, reads, and publishes.
 */
export function createRunsRouter(deps: RunsRouterDeps): Router {
  const { repo, store } = deps;
  const router = Router();

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (e) {
        if (e instanceof SchemaNotReadyError) {
          res.status(503).json({ error: e.message });
          return;
        }
        throw e;
      }
    };

  router.post(
    "/runs",
    requireWallet,
    handle(async (req, res) => {
      const wallet = req.wallet!;
      const body = (req.body ?? {}) as { agentId?: unknown; benchmarkId?: unknown; benchmarkVersion?: unknown; modelApiKey?: unknown };
      if (!isNonEmptyString(body.agentId) || !UUID_RE.test(body.agentId)) {
        res.status(400).json({ error: "agentId (uuid) is required" });
        return;
      }
      if (!isNonEmptyString(body.benchmarkId) || !isNonEmptyString(body.benchmarkVersion)) {
        res.status(400).json({ error: "benchmarkId and benchmarkVersion are required" });
        return;
      }
      // BYOK: the run uses the caller's own OpenRouter key. It is stored sealed, used only by the
      // worker's model gateway, wiped when the run ends, and never logged or returned.
      if (!isModelApiKey(body.modelApiKey)) {
        res.status(400).json({ error: "modelApiKey (your OpenRouter API key) is required" });
        return;
      }
      if (!deps.runKeySecret) {
        res.status(503).json({ error: "runs are not configured on this server (ITERA_RUN_KEY_SECRET)" });
        return;
      }
      const modelApiKeyEnc = encryptRunKey(body.modelApiKey.trim(), deps.runKeySecret);
      const taskPack = await repo.getTaskPack(body.benchmarkId, body.benchmarkVersion);
      if (!taskPack) {
        res.status(404).json({ error: `unknown benchmark ${body.benchmarkId}/${body.benchmarkVersion}` });
        return;
      }
      const agent = await store.getAgent(body.agentId);
      if (!agent) {
        res.status(404).json({ error: "agent not found" });
        return;
      }
      if (agent.ownerWallet !== wallet) {
        res.status(403).json({ error: "this agent belongs to another wallet" });
        return;
      }
      const version = await store.latestAgentVersion(agent.id);
      if (!version) {
        res.status(409).json({ error: "agent has no synced version yet — connect its repository first" });
        return;
      }
      const run = await store.createQueuedRun({
        ownerWallet: wallet,
        agentId: agent.id,
        agentVersion: version,
        taskPackId: taskPack.id,
        taskPackVersion: taskPack.version,
        nonce: randomUUID(),
        dailyLimit: RUNS_PER_WALLET_PER_DAY,
        modelApiKeyEnc,
      });
      if (!run) {
        res.status(429).json({ error: `daily limit reached: ${RUNS_PER_WALLET_PER_DAY} runs per wallet per 24h` });
        return;
      }

      let runStartMemo: { wireTransactionBase64: string } | null = null;
      let runStartMemoError: string | null = null;
      if (deps.buildRunStartTx) {
        try {
          runStartMemo = await deps.buildRunStartTx({
            runId: run.id,
            wallet,
            agentId: agent.id,
            repoFullName: agent.repoFullName,
            commitSha: version.commitSha,
            model: agent.model,
            benchmarkId: taskPack.id,
            benchmarkVersion: taskPack.version,
          });
        } catch (e) {
          // The run is queued either way. The memo is an optional on-chain receipt of the start.
          runStartMemoError = e instanceof Error ? e.message : String(e);
        }
      }
      res.status(202).json({ runId: run.id, status: "queued", runStartMemo, ...(runStartMemoError ? { runStartMemoError } : {}) });
    }),
  );

  router.get(
    "/runs",
    requireWallet,
    handle(async (req, res) => {
      if (req.query.mine !== "1") {
        res.status(400).json({ error: "only GET /runs?mine=1 is supported (public lists: GET /leaderboard)" });
        return;
      }
      const runs = await store.listRunsByOwner(req.wallet!, LIST_LIMIT);
      res.json({ runs: runs.map(summaryView) });
    }),
  );

  // Public read: a run page is shareable. The view is redacted (no hidden test names, no paths).
  router.get(
    "/runs/:id",
    handle(async (req, res) => {
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      const run = await store.getRun(id);
      if (!run || run.ownerWallet === null) {
        // Legacy /evaluations runs have no owner; they stay on the legacy routes.
        res.status(404).json({ error: "run not found" });
        return;
      }
      res.json(await detailView(store, run));
    }),
  );

  router.post(
    "/runs/:id/publish",
    requireWallet,
    handle(async (req, res) => {
      const id = String(req.params.id);
      const run = UUID_RE.test(id) ? await store.getRun(id) : null;
      if (!run || run.ownerWallet === null) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      if (run.ownerWallet !== req.wallet) {
        res.status(403).json({ error: "only the owner of the run can publish it" });
        return;
      }
      if (!TERMINAL_STATUSES.includes(run.status)) {
        res.status(409).json({ error: `run is ${run.status}; publish needs a finished run` });
        return;
      }
      if (!isGradedManifest(run.evidenceManifest)) {
        res.status(409).json({ error: `run ended as ${run.status} without a graded evidence manifest; nothing to prove` });
        return;
      }
      const manifestSha256 = digestOf(run.evidenceManifest);

      // Idempotent: a pending or confirmed proof is returned as is. Only a failed proof is retried.
      const existing = await store.getProof(run.id);
      if (existing && existing.status !== "failed") {
        res.json({ proofHash: existing.manifestSha256 ?? manifestSha256, status: existing.status });
        return;
      }
      if (!deps.proofIssuer) {
        res.status(503).json({ error: "proof issuer is not available yet", proofHash: manifestSha256 });
        return;
      }
      const [agent, agentVersion] = await Promise.all([
        run.agentId ? store.getAgent(run.agentId) : Promise.resolve(null),
        run.agentVersionId ? store.getAgentVersion(run.agentVersionId) : Promise.resolve(null),
      ]);
      const result = await deps.proofIssuer.issueProof({
        run,
        manifest: run.evidenceManifest,
        manifestSha256,
        criteria: criteriaFromManifest(run.evidenceManifest),
        agent,
        agentVersion,
      });
      res.status(result.status === "failed" ? 502 : 200).json({
        proofHash: result.proofHash,
        status: result.status,
        ...(result.error ? { error: redactText(result.error) } : {}),
      });
    }),
  );

  return router;
}
