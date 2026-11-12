/**
 * Self-declared local results (plan 20261026-tma-local-runner-and-self-declared-results, ADR-1, ADR-2;
 * task L3). The ONE door through which a result that TMA did not run enters TMA.
 *
 * The router validates the body against the closed contract of @itera/contracts (numbers only). The
 * store does the database checks and the writes in ONE transaction:
 *   agent of the caller → known model → readable task (catalog) or free slug (local) → daily cap →
 *   ONE evaluation (payment_kind 'none', result_origin 'self_declared', status 'graded', private) and
 *   ONE run (seq 1, the same id).
 * Idempotent: the ids come from (principal, task, agent, executor); the digest of the body decides
 * inserted / updated / unchanged. `dryRun` runs every check and write, then rolls back.
 *
 * Owner only (plan Q4 = C, TG 23676): a self-declared row is private (a 0021 CHECK) and every read
 * route scopes it to its owner.
 */
import { createHash } from "node:crypto";
import type { LocalResult, LocalResultV2Plus, TrajectoryStep } from "@itera/contracts";
import { agentVersionSha256 } from "@itera/contracts";

export const SELF_DECLARED_MIGRATION = "0021_self_declared_results.sql";
/** tma-local-result/2 needs this migration (plan 20261112-tma-c4-result-store-trajectory-upload, T2). */
export const EVAL_RESULTS_MIGRATION = "0023_eval_results.sql";
/**
 * The task summary of a case, the tma-trajectory/2 step fields and the grader version and label fields need this
 * migration (plan 20261112-tma-c4-result-store-trajectory-upload, T9, T10, T11).
 */
export const EVAL_META_MIGRATION = "0024_eval_summary_steps_grader_meta.sql";
const GRADER_META_KEYS = ["proof", "calibration", "note", "author", "reason_code", "labeler"] as const;

/** True when a /3 body carries a field that only migration 0024 can store (a /2 body has none of them). */
export function usesEvalMetaFields(r: LocalResultV2Plus): boolean {
  if (r.case.task_summary != null) return true;
  for (const run of r.runs) {
    if (run.trajectory?.format === "tma-trajectory/2") return true;
    for (const g of run.graders) if (GRADER_META_KEYS.some((k) => g[k] != null)) return true;
  }
  return false;
}
/**
 * The result-plane tenant of every self-declared v2 row (plan ADR-4, parent ADR-11). Only `dfl`
 * principals upload today, so the default is the fleet; TMA_RESULT_TENANT overrides it (C10 adds onboarding).
 */
export const DEFAULT_RESULT_TENANT = "devfellowship";
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function resultTenantFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const t = env.TMA_RESULT_TENANT?.trim();
  return t && TENANT_RE.test(t) ? t : DEFAULT_RESULT_TENANT;
}
export const DEFAULT_SELF_DECLARED_PER_DAY = 50;

export type ImportAction = "inserted" | "updated" | "unchanged";

export interface ImportOutcome {
  evaluationId: string;
  runId: string;
  action: ImportAction;
  outcome: "pass" | "fail";
  taskId: string;
  taskVersionId: string;
  dryRun: boolean;
}

export interface ImportOptions {
  /** Run every check and write, then roll back. */
  dryRun: boolean;
  /** At most this many NEW self-declared evaluations per principal per 24 h. */
  perDay: number;
}

/** A refusal with its HTTP status and machine code. Thrown before any write commits. */
export class SelfDeclaredError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 429,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The answer of a tma-local-result/2 import: one evaluation (case × agent variant + executor), one row per run. */
export interface ImportOutcomeV2 {
  evaluationId: string;
  caseId: string;
  variantId: string;
  /** Every run row of the evaluation, in seq order (the old ones included). */
  runIds: string[];
  action: ImportAction;
  outcome: "pass" | "fail";
  /** What this upload did to the runs it named. */
  runs: { inserted: number; updated: number; unchanged: number };
  taskId: string;
  taskVersionId: string;
  dryRun: boolean;
}

export interface ImportOptionsV2 extends ImportOptions {
  /** The result-plane tenant of the new rows (resultTenantFromEnv). */
  tenant: string;
}

export interface SelfDeclaredStore {
  importResult(principal: string, result: LocalResult, options: ImportOptions): Promise<ImportOutcome>;
  /**
   * tma-local-result/2 (plan 20261112-tma-c4-result-store-trajectory-upload, T3, T8, ADR-1). In ONE transaction:
   * the v1 checks; the test case and the agent variant, two independent upserts (parent plan ADR-26); the
   * baseline of the case (eval_cases.baseline_variant_id: the first wins, another one is 409 baseline_exists);
   * one evaluation per (principal, task, agent, executor, case, base agent, diff) = one crossing; one `runs`
   * row per run of the body, keyed by (item, kind, repeat), with its grader rows and trajectory rows. A
   * re-upload of the same runs is `unchanged`; a new repeat adds a row; a changed run is updated, its
   * trajectory replaced and its grader rows ADDED (a re-grade never updates a grader row).
   */
  importResultV2(principal: string, result: LocalResultV2Plus, options: ImportOptionsV2): Promise<ImportOutcomeV2>;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (shared by the pg store and the fake store)
// ---------------------------------------------------------------------------------------------

/** A stable UUID from a name: sha256, formatted with version 8 and the RFC 4122 variant (bench-import's scheme). */
export function stableUuid(name: string): string {
  const h = createHash("sha256").update(name).digest("hex").slice(0, 32).split("");
  h[12] = "8";
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** The executor identity: the model id, plus the variant when there is one. */
export function executorKey(r: Pick<LocalResult, "executor">): string {
  return r.executor.variant ? `${r.executor.model_id}#${r.executor.variant}` : r.executor.model_id;
}

/** `catalog:<slug>@<version>` or `local:<slug>`. */
export function taskRef(r: Pick<LocalResult, "task">): string {
  return "catalog" in r.task ? `catalog:${r.task.catalog.slug}@${r.task.catalog.version}` : `local:${r.task.local.slug}`;
}

/** The one id of the evaluation AND its run. The principal is part of it: two users never share an id. */
export function selfDeclaredId(principal: string, r: LocalResult): string {
  return stableUuid(`self-declared:${principal}:${taskRef(r)}:${r.agent_id}:${executorKey(r)}`);
}

/**
 * v2: the case key, the base agent digest and the diff digest join the v1 key, so a second agent variant on
 * the same case is a second evaluation (one evaluation = one crossing of a case and an agent variant).
 */
export function selfDeclaredIdV2(principal: string, r: LocalResultV2Plus): string {
  return stableUuid(
    `self-declared:${principal}:${taskRef(r)}:${r.agent_id}:${executorKey(r)}:${r.case.case_key}:${agentVersionSha256(r.variant.agent)}:${r.variant.variant_sha256}`,
  );
}

type RunV2 = LocalResultV2Plus["runs"][number];

/** The identity of one run inside its evaluation: the item, the kind (mining and trajectory shapes) and the repeat. */
export function runKeyV2(run: RunV2): string {
  const kind = typeof run.kind === "string" ? run.kind : "";
  return `${run.item_sha256}:${kind}:${run.repeat}`;
}

/** The id of one v2 run row: stable, so a re-upload finds the same row. */
export function runIdV2(evaluationId: string, run: RunV2): string {
  return stableUuid(`self-declared-run:${evaluationId}:${runKeyV2(run)}`);
}

/**
 * The status of one v2 run row. infra_ok false → infra_error (not the agent's fault). tma-score/1: the
 * run's own status. The other shapes: every hard-gate grader passes and the score is above 0.
 */
export function runStatusV2(r: LocalResultV2Plus, run: RunV2): "pass" | "fail" | "infra_error" {
  if (run.infra_ok === false) return "infra_error";
  if (r.metrics_shape === "tma-score/1") return run.status === "pass" ? "pass" : "fail";
  const gates = run.graders.filter((g) => g.hard_gate);
  return run.score > 0 && gates.every((g) => g.pass) ? "pass" : "fail";
}

/** The run's numbers as evidence: no grader rows and no trajectory (they have their own tables). */
export function runEvidenceV2(r: LocalResultV2Plus, run: RunV2, digest: string) {
  const { graders: _graders, trajectory: _trajectory, ...numbers } = run;
  return {
    kind: r.format,
    metrics_shape: r.metrics_shape,
    import_digest: digest,
    grader_version: r.grader_version,
    runner: r.runner,
    executor: r.executor,
    ran_from: r.ran_from,
    ran_to: r.ran_to,
    case_key: r.case.case_key,
    agent_sha256: agentVersionSha256(r.variant.agent),
    variant_sha256: r.variant.variant_sha256,
    item: numbers,
  };
}

/** What a reader needs from a trajectory without its rows: step count, first failed step, error classes. */
export interface TrajectorySummary {
  steps: number;
  firstFailureSeq: number | null;
  errorClasses: Record<string, number>;
}

export function trajectorySummaryOf(steps: ReadonlyArray<Pick<TrajectoryStep, "seq" | "status" | "error_class">>): TrajectorySummary {
  const errorClasses: Record<string, number> = {};
  let firstFailureSeq: number | null = null;
  for (const s of [...steps].sort((a, b) => a.seq - b.seq)) {
    if (s.status !== "ok" && firstFailureSeq === null) firstFailureSeq = s.seq;
    if (s.error_class) errorClasses[s.error_class] = (errorClasses[s.error_class] ?? 0) + 1;
  }
  return { steps: steps.length, firstFailureSeq, errorClasses };
}

/** JSON with sorted object keys, so the digest does not depend on the client's key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Digest of what the import writes; equal digest = nothing to update. */
export function resultDigest(r: LocalResult | LocalResultV2Plus | RunV2): string {
  return createHash("sha256").update(canonical(r)).digest("hex");
}

/** Pass rule of the trajectory shape (the bench-import rule): at least 95% of the runs pass all 5 rule gates. */
export const TRAJECTORY_GATE_PASS_MIN = 0.95;

/**
 * tma-score/1: pass = every run passed. transcript-mining/1: the plan Q4-A gates (bench-import).
 * trajectory/1: gate_pass_rate >= 0.95 (bench-import).
 */
export function outcomeOf(r: LocalResult): "pass" | "fail" {
  const s = r.summary as Record<string, unknown>;
  if (r.metrics_shape === "tma-score/1") return r.runs.every((x) => x.status === "pass") ? "pass" : "fail";
  if (r.metrics_shape === "transcript-mining/1") return s.gate_schema_q4a === true && s.gate_quotes_q4a === true ? "pass" : "fail";
  return typeof s.gate_pass_rate === "number" && s.gate_pass_rate >= TRAJECTORY_GATE_PASS_MIN ? "pass" : "fail";
}

/** Route prefixes whose model ids are "known" without a catalog row (they never run on OpenRouter). */
const NON_CATALOG_ROUTES = new Set(["opencode-go", "ollama", "zai", "codex", "claude-code", "minimax"]);

/**
 * How to check a model id: an id under a non-OpenRouter route prefix is known as is; `openrouter/<id>`
 * and a plain `<author>/<model>` are known when `public.models` has the OpenRouter id.
 */
export function modelLookup(modelId: string): { known: true } | { catalogId: string } {
  const [prefix] = modelId.split("/");
  if (prefix && NON_CATALOG_ROUTES.has(prefix)) return { known: true };
  return { catalogId: prefix === "openrouter" ? modelId.slice("openrouter/".length) : modelId };
}

const sum = (xs: Array<number | null>) => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

/** The typed run columns, derived from the numbers. */
export function runNumbers(r: LocalResult) {
  const s = r.summary as Record<string, number | boolean | null>;
  const num = (k: string) => (typeof s[k] === "number" ? (s[k] as number) : null);
  const costUsd = num("cost_total_usd") ?? sum(r.runs.map((x) => x.cost_usd));
  const tokensIn = num("tokens_in_total") ?? sum(r.runs.map((x) => x.tokens_in));
  const tokensOut = num("tokens_out_total") ?? sum(r.runs.map((x) => x.tokens_out));
  const walls = r.runs.map((x) => x.wall_s).filter((x): x is number => typeof x === "number");
  const timePerTask = num("time_per_task_s") ?? (walls.length ? walls.reduce((a, b) => a + b, 0) / walls.length : null);
  return {
    score: r.summary.score,
    scoreTotal: Math.round(r.summary.score),
    costUsd,
    tokensIn: tokensIn == null ? null : Math.round(tokensIn),
    tokensOut: tokensOut == null ? null : Math.round(tokensOut),
    wallMs: timePerTask == null ? null : Math.round(timePerTask * 1000),
    // runs.model_cost_source has no 'reported': a reported cost is derived by the user (bench-import's mapping).
    costSource: r.executor.cost_source === "reported" ? "derived" : r.executor.cost_source,
    testsPassed: r.metrics_shape === "tma-score/1" ? r.runs.filter((x) => x.status === "pass").length : r.runs.filter((x) => x.score > 0).length,
    testsTotal: r.runs.length,
  };
}

/** runs.evidence_manifest of a self-declared run: numbers only, never an evaluator EvalLog. */
export function evidenceOf(r: LocalResult, digest: string) {
  return {
    kind: r.format,
    metrics_shape: r.metrics_shape,
    import_digest: digest,
    grader_version: r.grader_version,
    runner: r.runner,
    executor: r.executor,
    ran_from: r.ran_from,
    ran_to: r.ran_to,
    summary: r.summary,
    items: r.runs,
  };
}

/** runs.provenance of a self-declared run. `source` is what the 0021 relabel and the readers key on. */
export function provenanceOf(r: LocalResult) {
  return {
    source: "self-declared",
    task_ref: taskRef(r),
    metrics_shape: r.metrics_shape,
    execution: r.runner.execution,
    runner_version: r.runner.version,
    profile: r.runner.profile,
    sandbox_image_id: r.runner.sandbox_image_id,
    route: r.executor.route,
    harness: r.executor.harness,
    cost_source: r.executor.cost_source,
    ...(r.executor.variant ? { variant: r.executor.variant } : {}),
    runs: r.runs.length,
    items: r.summary.items,
    grader_version: r.grader_version,
  };
}
