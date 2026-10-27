import { createHash, randomUUID } from "node:crypto";
import { isEvidenceManifest, runResult } from "@itera/contracts";
import { ARTIFACT_LIMITS, PATCH_ARTIFACT_PATH, PATCH_CONTENT_TYPE, artifactType, isSafeArtifactPath, type ArtifactKind } from "@itera/contracts/run-artifacts";
import { Router, type Request, type Response } from "express";
import { digestOf } from "../domain/digest.js";
import type { EvidenceManifest } from "../domain/evidence-manifest.js";
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
import { openRouterPrices, type PriceLookup } from "../domain/model-prices.js";
import { HOSTED_NOT_AVAILABLE_WEB2_MESSAGE, LOCAL_RUNNER_STEPS, SELF_DECLARED_ROUTE } from "../evaluations/web2-hosted-gate.js";
import type { RunOriginLookup } from "../self-declared/run-guard.js";
import { optionalWallet, requireWallet } from "./auth.js";
import { sanitizeActionTarget, sanitizeToolName } from "./run-actions.js";

/**
 * Contract: "per-wallet limit 5 runs/day". ITERA pays the model tokens (Tainan TG 20967, plan
 * 20261012-itera-testmyagent-ui-refactor Q2 = B); BYOK (`modelApiKey`) stays optional.
 * `siws` principals only: a `dfl` principal gets 410 (`LEGACY_RUNS_GONE_FOR_DFL`).
 */
export const RUNS_PER_WALLET_PER_DAY = Number(process.env.ITERA_RUNS_PER_WALLET_PER_DAY ?? 5);

/** The run fee today (US$). ITERA subsidizes the model tokens inside it. */
export const RUN_FEE_USD = 0.1;
/** Same default as the runner gateway's hard cap (services/runner, ITERA_RUN_MAX_COST_USD). */
export const RUN_MAX_COST_USD = Number(process.env.ITERA_RUN_MAX_COST_USD ?? 0.5);
/**
 * Token budget of one run, for an estimate without history (list price × budget). Calibrated on the
 * first platform-key run of webhook-ledger; real history replaces it as soon as a (task, model) has runs.
 */
export const DEFAULT_RUN_TOKENS_IN = Number(process.env.ITERA_ESTIMATE_TOKENS_IN ?? 400_000);
export const DEFAULT_RUN_TOKENS_OUT = Number(process.env.ITERA_ESTIMATE_TOKENS_OUT ?? 12_000);
const LIST_LIMIT = 50;

/**
 * Body of the 410 that `POST /runs` answers to a `dfl` principal (T6, ADR-4 of plan
 * 20261023-tma-tools-on-learn-mcp). The legacy route has only a per-wallet daily cap and an optional
 * key: a run with no key spends ITERA's platform key. Since L15a (web2 = ingested only, Tainan TG 23889)
 * the hosted start routes (`POST /evaluations*`) refuse a `dfl` principal too, so the pointer goes to the
 * local runner and `POST /self-declared-results` (evaluations/web2-hosted-gate.ts). The status and the
 * `code` stay as they were: clients may key on them.
 */
export const LEGACY_RUNS_GONE_FOR_DFL = {
  error: "gone",
  code: "legacy_runs_retired_for_dfl",
  message: `POST /runs is retired for DFL sessions. ${HOSTED_NOT_AVAILABLE_WEB2_MESSAGE}`,
  replacement: { localRunner: { steps: [...LOCAL_RUNNER_STEPS] }, selfDeclared: SELF_DECLARED_ROUTE },
} as const;
/** Page size of GET /runs/:id/actions. */
export const ACTIONS_PAGE_LIMIT = 200;

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
  /** OpenRouter list prices for GET /models/:id/estimate. Defaults to the public model list. */
  prices?: PriceLookup;
  /** L17a: tells a self-declared run apart on GET /runs/:id/artifacts (it lists nothing, ADR-1). Absent → every run is hosted. */
  runOrigins?: RunOriginLookup;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A plausible API key: printable, no whitespace inside, bounded. The provider validates the rest. */
export function isModelApiKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{20,512}$/.test(value.trim());
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `value` is a graded EvalLog (runs.evidence_manifest): Ajv against
 * packages/contracts/schemas/evidence-manifest.schema.json. Replaces the hand-written key check.
 */
export function hasEvalLog(value: unknown): value is EvidenceManifest {
  return isEvidenceManifest(value);
}

// ---------------------------------------------------------------------------------------------
// Redaction. A public read must not show hidden-test names or worker filesystem paths.

const TMP_PATH_RE = /(?:\/private)?\/(?:tmp|var\/folders|var\/tmp|run\/user)\/[^\s'"`:,)]*/g;
const WORKSPACE_PATH_RE = /\/(?:workspace|work|home\/[^/\s]+|root)\/[^\s'"`:,)]*/g;
const HIDDEN_TEST_RE = /\b[\w./-]*hidden[\w./-]*/gi;

export function redactText(text: string): string {
  return text.replace(TMP_PATH_RE, "<tmp>").replace(WORKSPACE_PATH_RE, "<path>").replace(HIDDEN_TEST_RE, "<hidden-test>");
}

type SuiteCounts = { total: number; passed: number; failed: number };

/** Path of a test file relative to the fixture root (`tests/public.test.ts`), else redacted. */
export function fixtureRelativePath(file: string): string {
  const m = /\/fixture\/(.+)$/.exec(file);
  return m ? redactText(m[1]!) : redactText(file);
}

/** A public test suite for a public read: counts, plus per-case results without worker paths. */
export function publicSuiteView(suite: SuiteCounts & { cases?: unknown }) {
  const view: SuiteCounts & { cases?: { name: string; file: string; passed: boolean }[] } = {
    total: suite.total,
    passed: suite.passed,
    failed: suite.failed,
  };
  if (Array.isArray(suite.cases)) {
    view.cases = (suite.cases as { name?: unknown; file?: unknown; passed?: unknown }[]).map((c) => ({
      name: redactText(String(c.name ?? "")),
      file: fixtureRelativePath(String(c.file ?? "")),
      passed: c.passed === true,
    }));
  }
  return view;
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
    /** Model cost in USD, as billed by OpenRouter and measured by the runner. Null = not measured (yet). */
    modelCostUsd: run.modelCostUsd ?? null,
  };
}

/** Score version and gates of a graded run (no hidden test name, counts only). */
function scoreRuleView(m: EvidenceManifest) {
  const x = m as EvidenceManifest & { score_version?: number; score_rule?: { formula?: string; hidden?: string | null; gates?: Record<string, boolean | null> } };
  return {
    version: typeof x.score_version === "number" ? x.score_version : 1,
    ...(x.score_rule ? { rule: { formula: x.score_rule.formula ?? null, hidden: x.score_rule.hidden ?? null, gates: x.score_rule.gates ?? {} } } : {}),
  };
}

/** Pinned-evidence keys of the EvalLog (evaluator >= 0.2.0), for the run page. Null when absent. */
function evidenceView(m: EvidenceManifest) {
  const x = m as EvidenceManifest & {
    executor?: { profile?: string };
    environment_digest?: string;
    contract?: { contract_digest?: string };
    limitations?: string[];
  };
  return {
    executorProfile: x.executor?.profile ?? null,
    environmentDigest: x.environment_digest ?? null,
    contractDigest: x.contract?.contract_digest ?? null,
    limitations: Array.isArray(x.limitations) ? x.limitations.map((l) => redactText(String(l))) : [],
  };
}

// ---------------------------------------------------------------------------------------------
// L17a: the stored outputs of a hosted run (plan TMA L17; Tainan TG 24004). Owner only. The rules
// (allowlist, path rule, caps, storage encoding) are the shared module @itera/contracts/run-artifacts.

export interface ArtifactListEntry {
  path: string;
  contentType: string;
  kind: ArtifactKind;
  encoding: "utf-8" | "base64";
  bytes: number;
  sha256: string;
  href: string;
}

/** Headers of every artifact file answer: never rendered in the API origin, never cached, never sniffed. */
export const ARTIFACT_FILE_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cache-Control": "private, no-store",
});

export function artifactHref(runId: string, path: string): string {
  return `/runs/${runId}/artifacts/file?path=${encodeURIComponent(path)}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stored rows in path order, `result.json` first; a row whose path fails the shared rules is left out. */
export function artifactListEntries(runId: string, rows: ReadonlyArray<{ path: string; bytes: number; sha256: string }>): ArtifactListEntry[] {
  const first = (p: string) => (p === "result.json" ? 0 : 1);
  return rows
    .filter((r) => isSafeArtifactPath(r.path) && artifactType(r.path) !== null)
    .sort((a, b) => first(a.path) - first(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((r) => {
      const t = artifactType(r.path)!;
      return { path: r.path, contentType: t.contentType, kind: t.kind, encoding: t.encoding, bytes: r.bytes, sha256: r.sha256, href: artifactHref(runId, r.path) };
    });
}

/** The patch as the first list entry (its sha256 = sha256 of the patch text). */
export function patchListEntry(runId: string, patch: string): ArtifactListEntry {
  return { path: PATCH_ARTIFACT_PATH, contentType: PATCH_CONTENT_TYPE, kind: "diff", encoding: "utf-8", bytes: Buffer.byteLength(patch, "utf8"), sha256: sha256Hex(patch), href: artifactHref(runId, PATCH_ARTIFACT_PATH) };
}

function sendArtifactFile(res: Response, bytes: Buffer, contentType: string, path: string): void {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", String(bytes.length));
  for (const [k, v] of Object.entries(ARTIFACT_FILE_HEADERS)) res.setHeader(k, v);
  res.end(bytes);
}

async function detailView(store: RunsStore, run: AsyncRun, includePrivateArtifacts = false) {
  const manifest = hasEvalLog(run.evidenceManifest) ? run.evidenceManifest : null;
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
    // Score version 2 (TMA-QC = B): total = hidden ratio × 100 when the gates hold. A log without
    // `score_version` is version 1 (the sum of the parts). The parts stay as diagnostics.
    score: { parts, ...(manifest ? scoreRuleView(manifest) : {}) },
    tests: manifest
      ? {
          public: publicSuiteView(manifest.tests.public_after_patch),
          publicBaseline: publicSuiteView(manifest.tests.public_baseline),
          // Counts only. Hidden test names never leave the worker.
          hidden: { total: manifest.tests.hidden.total, passed: manifest.tests.hidden.passed, failed: manifest.tests.hidden.failed },
        }
      : null,
    patchScope: manifest ? { changedFiles: includePrivateArtifacts ? manifest.patch_scope.changed_files : [], allowed: manifest.patch_scope.allowed } : null,
    patch: includePrivateArtifacts ? patch : null,
    actionsCount,
    modelTokens: run.modelTokensIn == null && run.modelTokensOut == null ? null : { in: run.modelTokensIn ?? 0, out: run.modelTokensOut ?? 0 },
    errors: includePrivateArtifacts ? errors.map(redactText) : [],
    proof: proofView(proof),
    /** Operational state kept apart from the verdict; scored=false means score.total measures nothing. */
    result: runResult(run.status, manifest as { result?: { state: string; verdict: string; scored: boolean } } | null),
    evidence: includePrivateArtifacts && manifest ? evidenceView(manifest) : null,
  };
}

/**
 * POST /runs · GET /runs/:id · GET /runs/:id/actions · GET /runs/:id/artifacts[/file] · GET /runs?mine=1 · POST /runs/:id/publish — the async, wallet-owned
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
      // T6 (plan 20261023-tma-tools-on-learn-mcp, ADR-4): a run with no key spends ITERA's platform key
      // (services/runner/src/worker.ts), and this route has none of the free-path controls. Since L15a a
      // `dfl` principal runs locally (tma) and sends the result to POST /self-declared-results. Refused
      // before any read or write.
      if (req.principal?.kind === "dfl") {
        res.status(410).json(LEGACY_RUNS_GONE_FOR_DFL);
        return;
      }
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
      // ITERA pays the model tokens by default: no key → the runner uses ITERA's platform key.
      // BYOK (optional): the caller's own OpenRouter key. It is stored sealed, used only by the
      // worker's model gateway, wiped when the run ends, and never logged or returned.
      let modelApiKeyEnc: string | null = null;
      if (body.modelApiKey !== undefined && body.modelApiKey !== null && body.modelApiKey !== "") {
        if (!isModelApiKey(body.modelApiKey)) {
          res.status(400).json({ error: "modelApiKey is not a valid OpenRouter API key (omit it to let TestMyAgent pay the model tokens)" });
          return;
        }
        if (!deps.runKeySecret) {
          res.status(503).json({ error: "BYOK is not configured on this server (ITERA_RUN_KEY_SECRET); omit modelApiKey" });
          return;
        }
        modelApiKeyEnc = encryptRunKey(body.modelApiKey.trim(), deps.runKeySecret);
      }
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

  // GET /models/:id/estimate?task=&version= — estimated model cost of ONE run (USD). Public.
  // The model id has a slash (vendor/model): both the raw and the %2F-encoded forms work.
  // history = average recorded cost of finished runs of (task, model); else list price × default budget.
  // Informational: it supports a future dynamic price (cost + margin). It changes no charge.
  const prices = deps.prices ?? openRouterPrices();
  router.get(
    /^\/models\/(.+)\/estimate$/,
    handle(async (req, res) => {
      const raw = String((req.params as Record<string, string>)[0] ?? "");
      let model: string;
      try {
        model = decodeURIComponent(raw);
      } catch {
        model = raw;
      }
      const task = typeof req.query.task === "string" ? req.query.task : "";
      const version = typeof req.query.version === "string" ? req.query.version : "";
      if (!/^[A-Za-z0-9._:~-]+\/[A-Za-z0-9._:~-]+$/.test(model) || model.length > 200) {
        res.status(400).json({ error: "model id must look like vendor/model" });
        return;
      }
      if (!task || !version) {
        res.status(400).json({ error: "task and version query parameters are required" });
        return;
      }
      const base = { model, task, version, currency: "USD", runFeeUsd: RUN_FEE_USD, maxCostPerRunUsd: RUN_MAX_COST_USD };
      const stats = await store.costStats(task, version, model);
      if (stats.runs > 0 && stats.avgCostUsd !== null) {
        res.json({
          ...base,
          estimatedCostUsd: round6(stats.avgCostUsd),
          basis: "history",
          sampleSize: stats.runs,
          tokens: { in: Math.round(stats.avgTokensIn ?? 0), out: Math.round(stats.avgTokensOut ?? 0) },
        });
        return;
      }
      const price = await prices(model);
      if (!price) {
        res.status(404).json({ ...base, error: "no recorded runs and no OpenRouter list price for this model" });
        return;
      }
      const cost = price.prompt * DEFAULT_RUN_TOKENS_IN + price.completion * DEFAULT_RUN_TOKENS_OUT;
      res.json({
        ...base,
        estimatedCostUsd: round6(Math.min(cost, RUN_MAX_COST_USD)),
        basis: "list_price",
        sampleSize: 0,
        tokens: { in: DEFAULT_RUN_TOKENS_IN, out: DEFAULT_RUN_TOKENS_OUT },
        pricePerMillionTokens: { prompt: round6(price.prompt * 1e6), completion: round6(price.completion * 1e6) },
      });
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
    optionalWallet,
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
      res.json(await detailView(store, run, req.wallet === run.ownerWallet));
    }),
  );

  // Public read, like GET /runs/:id: the agent's tool calls, for the event log of screen 04.
  // Paginated by after_seq (rows with seq > after_seq, at most 200). `target` is sanitized: it is a shell
  // command or path from the sandbox, so no absolute path, secret or URL query string goes out.
  router.get(
    "/runs/:id/actions",
    handle(async (req, res) => {
      const id = String(req.params.id);
      const run = UUID_RE.test(id) ? await store.getRun(id) : null;
      if (!run || run.ownerWallet === null) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      const rawAfter = req.query.after_seq;
      let afterSeq = 0;
      if (rawAfter !== undefined && rawAfter !== "") {
        if (typeof rawAfter !== "string" || !/^\d{1,9}$/.test(rawAfter)) {
          res.status(400).json({ error: "after_seq must be a non-negative integer" });
          return;
        }
        afterSeq = Number(rawAfter);
      }
      let limit = ACTIONS_PAGE_LIMIT;
      if (req.query.limit !== undefined && req.query.limit !== "") {
        const l = typeof req.query.limit === "string" && /^\d{1,4}$/.test(req.query.limit) ? Number(req.query.limit) : 0;
        if (l < 1 || l > ACTIONS_PAGE_LIMIT) {
          res.status(400).json({ error: `limit must be an integer from 1 to ${ACTIONS_PAGE_LIMIT}` });
          return;
        }
        limit = l;
      }
      // One extra row tells whether another page exists.
      const rows = (await store.listActions(run.id, afterSeq, limit + 1)) ?? [];
      const page = rows.slice(0, limit);
      res.json({
        runId: run.id,
        afterSeq,
        actions: page.map((a) => ({
          seq: a.seq,
          tool: sanitizeToolName(a.tool),
          target: sanitizeActionTarget(a.target == null ? null : redactText(a.target.slice(0, 1000))),
          ok: a.ok,
          occurredAt: a.occurredAt,
        })),
        hasMore: rows.length > limit,
        nextAfterSeq: page.length ? page[page.length - 1]!.seq : afterSeq,
      });
    }),
  );

  // L17a: owner only. Not a UUID, unknown, legacy (no owner) or another wallet → the same 404.
  const ownedRun = async (req: Request): Promise<AsyncRun | null> => {
    const id = String(req.params.id);
    const run = UUID_RE.test(id) ? await store.getRun(id) : null;
    if (!run || run.ownerWallet === null || run.ownerWallet !== req.wallet) return null;
    return run;
  };
  const originOf = async (runId: string): Promise<"hosted" | "self_declared"> => (await deps.runOrigins?.originOf(runId))?.resultOrigin ?? "hosted";

  // GET /runs/:id/artifacts — the list: the patch first (when the run has one), then the stored rows
  // (result.json first, then path order). A self-declared run has none (ADR-1): reason "self_declared".
  router.get(
    "/runs/:id/artifacts",
    requireWallet,
    handle(async (req, res) => {
      const run = await ownedRun(req);
      if (!run) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      const resultOrigin = await originOf(run.id);
      const head = { runId: run.id, resultOrigin, limits: { ...ARTIFACT_LIMITS } };
      if (resultOrigin === "self_declared") {
        res.json({ ...head, reason: "self_declared", artifacts: [] });
        return;
      }
      const [patch, stored] = await Promise.all([store.getPatch(run.id), store.listArtifacts(run.id)]);
      const artifacts: ArtifactListEntry[] = [];
      if (patch !== null) artifacts.push(patchListEntry(run.id, patch));
      artifacts.push(...artifactListEntries(run.id, stored));
      res.json({ ...head, reason: artifacts.length === 0 ? "none_stored" : null, artifacts });
    }),
  );

  // GET /runs/:id/artifacts/file?path=<urlencoded path> — the raw bytes, always as an attachment.
  // A query parameter, not a wildcard segment: no path-to-regexp surprise. The content type comes
  // from the shared allowlist by extension, never from the stored row.
  router.get(
    "/runs/:id/artifacts/file",
    requireWallet,
    handle(async (req, res) => {
      const run = await ownedRun(req);
      if (!run) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      const raw = req.query.path;
      const path = typeof raw === "string" ? raw : null;
      if (path === null || (path !== PATCH_ARTIFACT_PATH && !isSafeArtifactPath(path))) {
        res.status(400).json({ error: "invalid path" });
        return;
      }
      if ((await originOf(run.id)) === "self_declared") {
        res.status(404).json({ error: "artifact not found" });
        return;
      }
      if (path === PATCH_ARTIFACT_PATH) {
        const patch = await store.getPatch(run.id);
        if (patch === null) {
          res.status(404).json({ error: "artifact not found" });
          return;
        }
        sendArtifactFile(res, Buffer.from(patch, "utf8"), `${PATCH_CONTENT_TYPE}; charset=utf-8`, path);
        return;
      }
      const type = artifactType(path);
      const row = type ? await store.getArtifact(run.id, path) : null;
      if (!type || !row) {
        res.status(404).json({ error: "artifact not found" });
        return;
      }
      const bytes = row.encoding === "base64" ? Buffer.from(row.content, "base64") : Buffer.from(row.content, "utf8");
      sendArtifactFile(res, bytes, type.encoding === "utf-8" ? `${type.contentType}; charset=utf-8` : type.contentType, path);
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
      if (!hasEvalLog(run.evidenceManifest)) {
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
