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
import type { LocalResult } from "@itera/contracts";

export const SELF_DECLARED_MIGRATION = "0021_self_declared_results.sql";
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

export interface SelfDeclaredStore {
  importResult(principal: string, result: LocalResult, options: ImportOptions): Promise<ImportOutcome>;
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
export function resultDigest(r: LocalResult): string {
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
