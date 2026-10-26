/**
 * Operator CLI: import ALREADY-GRADED benchmark results into one PRIVATE task of one account, so
 * every executor shows on that task as an evaluation row (plan
 * 20261023-tma-transcript-mining-executor-bakeoff, T11; Q1 = A "local run-once + score import").
 *
 *   tsx src/bench-import.ts --email <owner email> --owner <principal id> --input <file | -> [--apply]
 *
 * Why: the runs of a private task execute on the operator host against data that must never reach
 * GitHub or this DB (golden transcripts, labels). Only the graded NUMBERS come here: score, gates,
 * counts, metric values, wall time, cost, tokens, item sha256 values. The input is validated against
 * a closed schema; an unknown key or a free-text string is refused, so a file with transcript text
 * or a model answer in it cannot be imported.
 *
 * Path: the same sanctioned operator path as `bench-adopt.ts` — run INSIDE the runner container with
 * its existing `itera_api_service` DB role (no service_role, no user tool). The owner is named by
 * email AND principal id, and both must match one `users` row. The default executes every guard and
 * write in one transaction and then ROLLS BACK (a preview); `--apply` commits.
 *
 * Rows per executor (one evaluation row on the task page): vendor `ITERA benchmark campaign` →
 * agent `bench <model id>` (owned, private) → agent_version (`prompt-<sha>`, no files) →
 * release_declaration → ONE run (seq 1) holding the per-item results in `evidence_manifest.items`
 * → ONE `free_byok` evaluation in status `graded`. The run and the evaluation share a deterministic
 * UUID derived from (task slug, model id), so a re-run updates the same rows and never duplicates
 * them. A later file with more runs for an executor replaces that executor's numbers.
 *
 * Two closed result shapes (`format`):
 *   - `tma-bench-import/1`: the transcript-mining grader (gates schema + redaction, quote and correction counts).
 *   - `tma-bench-import/trajectory-1`: the session-decision-trajectory grader (plan
 *     20261025-session-trajectory-extraction, T7): 5 rule gates + 4 reference metrics per run, as 9 check
 *     booleans and the metric numbers. Same rows, same transaction; only the input schema and the pass rule differ.
 * An executor may carry `variant` (`structured-output`): the same model run with another harness setting. The
 * variant is part of the row id and the agent name, so it shows as its own evaluation row.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Pool } from 'pg';
import { BENCH_VENDOR } from './bench-enqueue.js';

export const IMPORT_FORMAT = 'tma-bench-import/1';
export const TRAJECTORY_FORMAT = 'tma-bench-import/trajectory-1';
const FORMATS = [IMPORT_FORMAT, TRAJECTORY_FORMAT] as const;
type Format = (typeof FORMATS)[number];
const VARIANTS = ['structured-output'] as const;

// ---------------------------------------------------------------------------------------------
// Input schema (closed). Every string field has a pattern; every object has an allowlist of keys.
// ---------------------------------------------------------------------------------------------

const SAFE_TEXT = /^[A-Za-z0-9 .,:;/()+\-_%$=&'#]*$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const LANES = ['alien', 'zai', 'codex', 'claude', 'opencode-go', 'minimax', 'baseline', 'tma'] as const;
const ROUTES = ['ollama', 'zai', 'codex', 'claude-code', 'opencode-go', 'openrouter', 'minimax'] as const;
const COST_SOURCES = ['derived', 'reported', 'metered', 'none'] as const;
const ERROR_CLASSES = ['timeout', 'empty_output', 'rate_limited', 'hang', 'infra_error'] as const;
const KINDS = ['main', 'subagent'] as const;
const STRATA = ['main-small', 'main-large', 'subagent-small', 'subagent-large'] as const;
const COUNT_KEYS = [
  'quotes', 'quotes_literal', 'quotes_artefact', 'quotes_trivial', 'quotes_all_keys', 'quotes_all_keys_literal',
  'corrections_pred', 'corrections_gold', 'corrections_gold_core', 'corrections_matched', 'corrections_core_found',
  'decisions_pred', 'decisions_gold', 'decisions_gold_core', 'decisions_matched', 'decisions_core_found', 'subagent_false_corrections',
] as const;
const SUMMARY_NUM_KEYS = [
  'score', 'runs', 'items', 'schema_valid_rate', 'quote_literalness_wilson_lb', 'quotes_total', 'invented_quote_rate', 'redaction_rebuilds',
  'correction_recall', 'correction_precision', 'subagent_false_corrections', 'meta_domain', 'meta_type', 'meta_outcome',
  'diag_decision_recall', 'diag_decision_precision', 'time_per_task_s', 'cost_per_task_usd', 'cost_total_usd',
  'tokens_in_total', 'tokens_out_total', 'errors',
] as const;

// The session-decision-trajectory grader (benchmarks/dfl-session-decision-trajectory-extraction, grader 1.x).
const TRAJ_GATES = ['schema', 'intents_closed', 'risk_floor', 'speaker', 'outcome_consistent'] as const;
const TRAJ_CHECKS = [...TRAJ_GATES, 'class_match', 'risk_match', 'intent_agreement', 'corrections'] as const;
const TRAJ_METRIC_NUMS = ['class_match', 'risk_match', 'intent_agreement', 'corrections', 'corrections_recall', 'corrections_precision'] as const;
const TRAJ_METRIC_BOOLS = ['class_type', 'class_subtype'] as const;
const TRAJ_SUMMARY_NUM_KEYS = [
  'score', 'runs', 'items', 'gate_pass_rate', 'check_pass_rate', 'mean_score_when_gates_pass',
  ...TRAJ_GATES.map((g) => `gate_fail_${g}` as const),
  'metric_class_match', 'metric_risk_match', 'metric_intent_agreement', 'metric_corrections',
  'time_per_task_s', 'items_per_hour', 'cost_per_task_usd', 'cost_total_usd', 'tokens_in_total', 'tokens_out_total', 'errors',
] as const;
/** Pass rule of the trajectory shape: at least 95% of the runs pass all 5 rule gates (the analogue of Q4-A schema-valid >= 0.95). */
export const TRAJECTORY_GATE_PASS_MIN = 0.95;

export interface TrajectoryRun {
  item_sha256: string; kind: (typeof KINDS)[number]; repeat: number; present: boolean;
  checks: Record<(typeof TRAJ_CHECKS)[number], boolean>;
  metrics: (Record<(typeof TRAJ_METRIC_NUMS)[number], number | null> & Record<(typeof TRAJ_METRIC_BOOLS)[number], boolean | null>) | null;
  score: number; wall_s: number | null; cost_usd: number | null; tokens_in: number | null; tokens_out: number | null;
  error_class: (typeof ERROR_CLASSES)[number] | null;
}
export type TrajectorySummary = Record<(typeof TRAJ_SUMMARY_NUM_KEYS)[number], number | null>;
type MiningSummary = Record<(typeof SUMMARY_NUM_KEYS)[number], number | null> & { gate_schema_q4a: boolean; gate_quotes_q4a: boolean };

export interface ImportRun {
  item_sha256: string; kind: (typeof KINDS)[number]; stratum: (typeof STRATA)[number] | null; repeat: number;
  present: boolean; gates: { schema: boolean; redaction: boolean }; schema_error_count: number;
  counts: Record<(typeof COUNT_KEYS)[number], number> | null;
  metrics: { meta_domain: boolean; meta_type: boolean; meta_outcome: boolean; links_f1: number | null } | null;
  score: number; wall_s: number | null; cost_usd: number | null; tokens_in: number | null; tokens_out: number | null;
  error_class: (typeof ERROR_CLASSES)[number] | null;
}
export interface ImportExecutor {
  model_id: string; label: string; lane: (typeof LANES)[number]; route: (typeof ROUTES)[number]; route_name: string; harness: string;
  cost_source: (typeof COST_SOURCES)[number]; cost_basis: string; model_requested: string; model_effective: string;
  think?: boolean | string | null; effort?: string | null; variant?: (typeof VARIANTS)[number] | null; ran_from: string; ran_to: string;
  summary: MiningSummary | TrajectorySummary;
  runs: Array<ImportRun | TrajectoryRun>;
}
export interface ImportFile {
  format: Format; generated_at: string;
  task: { slug: string; pack_id: string; pack_version: string; name: string; description: string };
  grader_version: string; score_version: string; golden_items: number; golden_manifest_sha256: string; prompt_sha256: string | null;
  labels_status: string; plan: string; executors: ImportExecutor[];
}

class InputError extends Error {}
const fail = (path: string, why: string): never => { throw new InputError(`input ${path}: ${why}`); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function keys(v: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isObj(v)) fail(path, 'must be an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) fail(`${path}.${k}`, 'unknown key (the import takes numbers and identifiers only)');
  for (const k of required) if (!(k in o)) fail(`${path}.${k}`, 'is required');
  return o;
}
function str(v: unknown, path: string, re: RegExp, max: number): string {
  if (typeof v !== 'string' || v.length > max || !re.test(v)) fail(path, `must be a string of at most ${max} characters matching ${re}`);
  return v as string;
}
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[], nullable = false): T | null {
  if (nullable && v === null) return null;
  if (typeof v !== 'string' || !allowed.includes(v as T)) fail(path, `must be one of ${allowed.join(', ')}${nullable ? ' or null' : ''}`);
  return v as T;
}
function num(v: unknown, path: string, { min = 0, max = Number.MAX_SAFE_INTEGER, int = false, nullable = false } = {}): number | null {
  if (nullable && v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) fail(path, `must be a ${int ? 'whole ' : ''}number in [${min}, ${max}]${nullable ? ' or null' : ''}`);
  return v as number;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'must be true or false');
  return v as boolean;
}

function parseRun(v: unknown, path: string): ImportRun {
  const o = keys(v, path, ['item_sha256', 'kind', 'stratum', 'repeat', 'present', 'gates', 'schema_error_count', 'counts', 'metrics', 'score', 'wall_s', 'cost_usd', 'tokens_in', 'tokens_out', 'error_class']);
  const g = keys(o.gates, `${path}.gates`, ['schema', 'redaction']);
  let counts: ImportRun['counts'] = null;
  if (o.counts !== null) {
    const c = keys(o.counts, `${path}.counts`, COUNT_KEYS);
    counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, num(c[k], `${path}.counts.${k}`, { int: true, max: 100_000 })])) as ImportRun['counts'];
  }
  let metrics: ImportRun['metrics'] = null;
  if (o.metrics !== null) {
    const m = keys(o.metrics, `${path}.metrics`, ['meta_domain', 'meta_type', 'meta_outcome', 'links_f1']);
    metrics = { meta_domain: bool(m.meta_domain, `${path}.metrics.meta_domain`), meta_type: bool(m.meta_type, `${path}.metrics.meta_type`), meta_outcome: bool(m.meta_outcome, `${path}.metrics.meta_outcome`), links_f1: num(m.links_f1, `${path}.metrics.links_f1`, { max: 1, nullable: true }) };
  }
  return {
    item_sha256: str(o.item_sha256, `${path}.item_sha256`, SHA256, 64),
    kind: oneOf(o.kind, `${path}.kind`, KINDS)!,
    stratum: oneOf(o.stratum, `${path}.stratum`, STRATA, true),
    repeat: num(o.repeat, `${path}.repeat`, { min: 1, max: 100, int: true })!,
    present: bool(o.present, `${path}.present`),
    gates: { schema: bool(g.schema, `${path}.gates.schema`), redaction: bool(g.redaction, `${path}.gates.redaction`) },
    schema_error_count: num(o.schema_error_count, `${path}.schema_error_count`, { int: true, max: 10_000 })!,
    counts, metrics,
    score: num(o.score, `${path}.score`, { max: 100 })!,
    wall_s: num(o.wall_s, `${path}.wall_s`, { max: 86_400, nullable: true }),
    cost_usd: num(o.cost_usd, `${path}.cost_usd`, { max: 1_000, nullable: true }),
    tokens_in: num(o.tokens_in, `${path}.tokens_in`, { int: true, max: 100_000_000, nullable: true }),
    tokens_out: num(o.tokens_out, `${path}.tokens_out`, { int: true, max: 100_000_000, nullable: true }),
    error_class: oneOf(o.error_class, `${path}.error_class`, ERROR_CLASSES, true),
  };
}

function parseTrajectoryRun(v: unknown, path: string): TrajectoryRun {
  const o = keys(v, path, ['item_sha256', 'kind', 'repeat', 'present', 'checks', 'metrics', 'score', 'wall_s', 'cost_usd', 'tokens_in', 'tokens_out', 'error_class']);
  const c = keys(o.checks, `${path}.checks`, TRAJ_CHECKS);
  let metrics: TrajectoryRun['metrics'] = null;
  if (o.metrics !== null) {
    const m = keys(o.metrics, `${path}.metrics`, [...TRAJ_METRIC_NUMS, ...TRAJ_METRIC_BOOLS]);
    metrics = Object.fromEntries([
      ...TRAJ_METRIC_NUMS.map((k) => [k, num(m[k], `${path}.metrics.${k}`, { max: 1, nullable: true })]),
      ...TRAJ_METRIC_BOOLS.map((k) => [k, m[k] === null ? null : bool(m[k], `${path}.metrics.${k}`)]),
    ]) as TrajectoryRun['metrics'];
  }
  return {
    item_sha256: str(o.item_sha256, `${path}.item_sha256`, SHA256, 64),
    kind: oneOf(o.kind, `${path}.kind`, KINDS)!,
    repeat: num(o.repeat, `${path}.repeat`, { min: 1, max: 100, int: true })!,
    present: bool(o.present, `${path}.present`),
    checks: Object.fromEntries(TRAJ_CHECKS.map((k) => [k, bool(c[k], `${path}.checks.${k}`)])) as TrajectoryRun['checks'],
    metrics,
    score: num(o.score, `${path}.score`, { max: 100 })!,
    wall_s: num(o.wall_s, `${path}.wall_s`, { max: 86_400, nullable: true }),
    cost_usd: num(o.cost_usd, `${path}.cost_usd`, { max: 1_000, nullable: true }),
    tokens_in: num(o.tokens_in, `${path}.tokens_in`, { int: true, max: 100_000_000, nullable: true }),
    tokens_out: num(o.tokens_out, `${path}.tokens_out`, { int: true, max: 100_000_000, nullable: true }),
    error_class: oneOf(o.error_class, `${path}.error_class`, ERROR_CLASSES, true),
  };
}

function parseExecutor(v: unknown, path: string, format: Format): ImportExecutor {
  const o = keys(v, path, ['model_id', 'label', 'lane', 'route', 'route_name', 'harness', 'cost_source', 'cost_basis', 'model_requested', 'model_effective', 'ran_from', 'ran_to', 'summary', 'runs'], ['think', 'effort', 'variant']);
  let summary: ImportExecutor['summary'];
  if (format === TRAJECTORY_FORMAT) {
    const s = keys(o.summary, `${path}.summary`, TRAJ_SUMMARY_NUM_KEYS);
    summary = Object.fromEntries(TRAJ_SUMMARY_NUM_KEYS.map((k) => [k, num(s[k], `${path}.summary.${k}`, { max: 1e12, nullable: true })])) as TrajectorySummary;
    if (summary.gate_pass_rate === null || summary.gate_pass_rate > 1) fail(`${path}.summary.gate_pass_rate`, 'must be a number in [0, 1]');
  } else {
    const s = keys(o.summary, `${path}.summary`, [...SUMMARY_NUM_KEYS, 'gate_schema_q4a', 'gate_quotes_q4a']);
    const m = Object.fromEntries(SUMMARY_NUM_KEYS.map((k) => [k, num(s[k], `${path}.summary.${k}`, { max: 1e12, nullable: true })])) as unknown as MiningSummary;
    m.gate_schema_q4a = bool(s.gate_schema_q4a, `${path}.summary.gate_schema_q4a`);
    m.gate_quotes_q4a = bool(s.gate_quotes_q4a, `${path}.summary.gate_quotes_q4a`);
    summary = m;
  }
  if (summary.score === null || summary.score > 100) fail(`${path}.summary.score`, 'must be a number in [0, 100]');
  if (!Array.isArray(o.runs) || o.runs.length === 0 || o.runs.length > 2_000) fail(`${path}.runs`, 'must be a list of 1 to 2000 runs');
  const runs = (o.runs as unknown[]).map((r, i) => (format === TRAJECTORY_FORMAT ? parseTrajectoryRun : parseRun)(r, `${path}.runs[${i}]`));
  if (summary.runs !== runs.length) fail(`${path}.summary.runs`, `says ${summary.runs}, the list has ${runs.length}`);
  let think: ImportExecutor['think'];
  if ('think' in o) think = o.think === null || typeof o.think === 'boolean' ? (o.think as boolean | null) : str(o.think, `${path}.think`, SAFE_TEXT, 24);
  const out: ImportExecutor = {
    model_id: str(o.model_id, `${path}.model_id`, MODEL_ID, 96),
    label: str(o.label, `${path}.label`, SAFE_TEXT, 60),
    lane: oneOf(o.lane, `${path}.lane`, LANES)!,
    route: oneOf(o.route, `${path}.route`, ROUTES)!,
    route_name: str(o.route_name, `${path}.route_name`, SAFE_TEXT, 60),
    harness: str(o.harness, `${path}.harness`, SAFE_TEXT, 120),
    cost_source: oneOf(o.cost_source, `${path}.cost_source`, COST_SOURCES)!,
    cost_basis: str(o.cost_basis, `${path}.cost_basis`, SAFE_TEXT, 160),
    model_requested: str(o.model_requested, `${path}.model_requested`, /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 96),
    model_effective: str(o.model_effective, `${path}.model_effective`, /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 96),
    ran_from: str(o.ran_from, `${path}.ran_from`, ISO, 24),
    ran_to: str(o.ran_to, `${path}.ran_to`, ISO, 24),
    summary, runs,
  };
  if (think !== undefined) out.think = think;
  if ('effort' in o) out.effort = o.effort === null ? null : str(o.effort, `${path}.effort`, /^[a-z]{1,16}$/, 16);
  if ('variant' in o) out.variant = oneOf(o.variant, `${path}.variant`, VARIANTS, true);
  if (Date.parse(out.ran_from) > Date.parse(out.ran_to)) fail(`${path}.ran_from`, 'is after ran_to');
  return out;
}

/** Validates an import file. Throws on any key or string outside the closed schema. */
export function parseImportFile(raw: unknown): ImportFile {
  const o = keys(raw, '$', ['format', 'generated_at', 'task', 'grader_version', 'score_version', 'golden_items', 'golden_manifest_sha256', 'prompt_sha256', 'labels_status', 'plan', 'executors']);
  const format = oneOf(o.format, '$.format', FORMATS)!;
  const t = keys(o.task, '$.task', ['slug', 'pack_id', 'pack_version', 'name', 'description']);
  if (!Array.isArray(o.executors) || o.executors.length === 0 || o.executors.length > 100) fail('$.executors', 'must be a list of 1 to 100 executors');
  const executors = (o.executors as unknown[]).map((e, i) => parseExecutor(e, `$.executors[${i}]`, format));
  const ids = new Set<string>();
  for (const [i, e] of executors.entries()) {
    const key = executorKey(e);
    if (ids.has(key)) fail(`$.executors[${i}].model_id`, `${key} appears twice`);
    ids.add(key);
  }
  return {
    format,
    generated_at: str(o.generated_at, '$.generated_at', ISO, 24),
    task: {
      slug: str(t.slug, '$.task.slug', SLUG, 63),
      pack_id: str(t.pack_id, '$.task.pack_id', SLUG, 63),
      pack_version: str(t.pack_version, '$.task.pack_version', /^[1-9][0-9]{0,5}$/, 6),
      name: str(t.name, '$.task.name', SAFE_TEXT, 60),
      description: str(t.description, '$.task.description', SAFE_TEXT, 120),
    },
    grader_version: str(o.grader_version, '$.grader_version', /^\d+\.\d+\.\d+$/, 16),
    score_version: str(o.score_version, '$.score_version', SAFE_TEXT, 24),
    golden_items: num(o.golden_items, '$.golden_items', { min: 1, max: 100_000, int: true })!,
    golden_manifest_sha256: str(o.golden_manifest_sha256, '$.golden_manifest_sha256', SHA256, 64),
    prompt_sha256: o.prompt_sha256 === null ? null : str(o.prompt_sha256, '$.prompt_sha256', SHA256, 64),
    labels_status: str(o.labels_status, '$.labels_status', SAFE_TEXT, 60),
    plan: str(o.plan, '$.plan', SLUG, 63),
    executors,
  };
}

// ---------------------------------------------------------------------------------------------
// Derived values (pure)
// ---------------------------------------------------------------------------------------------

/** A stable UUID from a name: sha256, formatted with version 8 and the RFC 4122 variant. */
export function stableUuid(name: string): string {
  const h = createHash('sha256').update(name).digest('hex').slice(0, 32).split('');
  h[12] = '8';
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** The executor identity on a task: the model id, plus the variant when there is one. */
export function executorKey(e: Pick<ImportExecutor, 'model_id' | 'variant'>): string {
  return e.variant ? `${e.model_id}#${e.variant}` : e.model_id;
}

/** The one id of an executor's run AND evaluation on a task (`key` = executorKey; a plain model id keeps the v1 ids). */
export function executorRowId(taskSlug: string, key: string): string {
  return stableUuid(`bench-import:${taskSlug}:${key}`);
}

/**
 * Mining shape: pass = the plan's Q4-A gates, schema-valid ≥ 95% and quote-literalness Wilson LB ≥ 0.90 (no rebuilds).
 * Trajectory shape: pass = at least 95% of the runs pass all 5 rule gates.
 */
export function executorOutcome(e: ImportExecutor): 'pass' | 'fail' {
  const s = e.summary;
  if ('gate_schema_q4a' in s) return s.gate_schema_q4a && s.gate_quotes_q4a ? 'pass' : 'fail';
  return (s.gate_pass_rate ?? 0) >= TRAJECTORY_GATE_PASS_MIN ? 'pass' : 'fail';
}

const OUTCOME_RULE: Record<Format, string> = {
  [IMPORT_FORMAT]: 'pass = schema_valid_rate >= 0.95 AND quote_literalness_wilson_lb >= 0.90 with 0 redaction rebuilds (plan Q4-A gates)',
  [TRAJECTORY_FORMAT]: `pass = gate_pass_rate >= ${TRAJECTORY_GATE_PASS_MIN} (share of runs that pass all 5 rule gates)`,
};

/** Digest of what the import writes for one executor; equal digest = nothing to update. */
export function executorDigest(file: ImportFile, e: ImportExecutor): string {
  const { executors: _all, generated_at: _at, ...common } = file;
  return createHash('sha256').update(JSON.stringify({ common, e })).digest('hex');
}

export function evidenceOf(file: ImportFile, e: ImportExecutor) {
  return {
    kind: file.format,
    import_digest: executorDigest(file, e),
    imported_from: { generated_at: file.generated_at, plan: file.plan },
    grader_version: file.grader_version,
    score_version: file.score_version,
    golden_items: file.golden_items,
    golden_manifest_sha256: file.golden_manifest_sha256,
    prompt_sha256: file.prompt_sha256,
    labels_status: file.labels_status,
    executor: {
      model_id: e.model_id, label: e.label, lane: e.lane, route: e.route, route_name: e.route_name, harness: e.harness,
      cost_source: e.cost_source, cost_basis: e.cost_basis, think: e.think ?? null, effort: e.effort ?? null,
      ...(e.variant ? { variant: e.variant } : {}),
      ran_from: e.ran_from, ran_to: e.ran_to,
    },
    outcome_rule: OUTCOME_RULE[file.format],
    summary: e.summary,
    items: e.runs,
  };
}

const dbCostSource = (s: ImportExecutor['cost_source']) => (s === 'reported' ? 'derived' : s);
const intOrNull = (x: number | null) => (x == null ? null : Math.round(x));

// ---------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------

export interface ImportScope { email: string; owner: string; contract: Record<string, unknown> }
export interface ImportSummary {
  apply: boolean; task: string; taskCreated: boolean; versionCreated: boolean;
  executors: number; inserted: number; updated: number; unchanged: number;
  rows: Array<{ model: string; id: string; action: 'inserted' | 'updated' | 'unchanged'; score: number | null; runs: number; outcome: 'pass' | 'fail' }>;
}

type Client = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>; release: () => void };

/**
 * Writes (or previews) the import in ONE transaction. Refuses, before any write, a principal that
 * does not match the email, a missing task pack, and any existing row of another owner.
 */
export async function importBench(pool: Pick<Pool, 'connect'>, file: ImportFile, scope: ImportScope, apply = false): Promise<ImportSummary> {
  if (!scope.email || !scope.owner) throw new Error('an explicit owner email and principal id are required');
  const c = (await pool.connect()) as unknown as Client;
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`bench-import:${file.task.slug}`]);
    const user = (await c.query('select principal_id from public.users where lower(email) = lower($1) and principal_id = $2', [scope.email, scope.owner])).rows;
    if (user.length !== 1) throw new Error('the email does not identify the expected principal');
    const pack = (await c.query('select id, version from public.task_packs where id = $1 and version = $2', [file.task.pack_id, file.task.pack_version])).rows[0];
    if (!pack) throw new Error(`task pack ${file.task.pack_id}@${file.task.pack_version} is not registered (the worker registers benchmarks/* at boot)`);

    const summary: ImportSummary = { apply, task: file.task.slug, taskCreated: false, versionCreated: false, executors: file.executors.length, inserted: 0, updated: 0, unchanged: 0, rows: [] };

    let task = (await c.query('select id, slug, kind, owner_wallet, visibility, deleted_at, name from public.tasks where slug = $1 for update', [file.task.slug])).rows[0];
    if (task && (task.owner_wallet !== scope.owner || task.kind !== 'itera' || task.visibility !== 'private' || task.deleted_at)) throw new Error(`conflicting task ${file.task.slug}: it exists with another owner, kind or visibility`);
    if (!task) {
      task = (await c.query(
        `insert into public.tasks (slug, kind, owner_wallet, name, description, visibility, status)
         values ($1, 'itera', $2, $3, $4, 'private', 'ready') returning id, slug, name`,
        [file.task.slug, scope.owner, file.task.name, file.task.description],
      )).rows[0];
      summary.taskCreated = true;
    }
    const validation = { source: 'bench-import', grader_version: file.grader_version, golden_items: file.golden_items, golden_manifest_sha256: file.golden_manifest_sha256, labels_status: file.labels_status, plan: file.plan };
    let tv = (await c.query('select id, source, pack_id from public.task_versions where task_id = $1 and version = 1', [task.id])).rows[0];
    if (tv && (tv.source !== 'curated' || tv.pack_id !== file.task.pack_id)) throw new Error(`conflicting task version ${file.task.slug}@1`);
    if (!tv) {
      tv = (await c.query(
        `insert into public.task_versions (task_id, version, source, contract, labels, pack_id, pack_version, fixture_digest, runnable, validation, validated_at, created_by)
         values ($1, 1, 'curated', $2, '{private-golden-set}', $3, $4, $5, false, $6, now(), $7) returning id`,
        [task.id, JSON.stringify(scope.contract), file.task.pack_id, file.task.pack_version, file.golden_manifest_sha256, JSON.stringify(validation), scope.owner],
      )).rows[0];
      summary.versionCreated = true;
    } else {
      await c.query('update public.task_versions set validation = $2 where id = $1', [tv.id, JSON.stringify(validation)]);
    }

    let vendor = (await c.query('select id from public.vendors where display_name = $1 order by created_at limit 1', [BENCH_VENDOR])).rows[0];
    if (!vendor) vendor = (await c.query('insert into public.vendors (display_name) values ($1) returning id', [BENCH_VENDOR])).rows[0];

    for (const e of file.executors) {
      const id = executorRowId(file.task.slug, executorKey(e));
      const name = `bench ${e.model_id}${e.variant ? ` ${e.variant}` : ''}`.slice(0, 120);
      const outcome = executorOutcome(e);
      const evidence = evidenceOf(file, e);

      const existingAgent = (await c.query('select id, owner_wallet from public.agents where vendor_id = $1 and name = $2 for update', [vendor.id, name])).rows[0];
      if (existingAgent?.owner_wallet && existingAgent.owner_wallet !== scope.owner) throw new Error(`conflicting agent ${name}: it has another owner`);
      const agent = (await c.query(
        `insert into public.agents (vendor_id, name, endpoint_url, model, connector, visibility, status, owner_wallet)
         values ($1, $2, $3, $4, 'endpoint', 'private', 'active', $5)
         on conflict (vendor_id, name) do update set model = excluded.model, owner_wallet = excluded.owner_wallet
         returning id`,
        [vendor.id, name, `bench://${encodeURIComponent(name)}`, e.model_id, scope.owner],
      )).rows[0];
      const commit = `prompt-${(file.prompt_sha256 ?? file.golden_manifest_sha256).slice(0, 40)}`;
      const version = (await c.query(
        `insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb)
         on conflict (agent_id, commit_sha) do update set commit_sha = excluded.commit_sha
         returning id`,
        [agent.id, commit],
      )).rows[0];
      const release = (await c.query(
        `insert into public.release_declarations (agent_id, release_ref) values ($1, $2)
         on conflict (agent_id, release_ref) do update set release_ref = excluded.release_ref
         returning id`,
        [agent.id, commit],
      )).rows[0];

      const prev = (await c.query(
        `select r.owner_wallet, r.evaluation_id, r.task_id, r.evidence_manifest ->> 'import_digest' as digest, e.owner_wallet as eval_owner
           from public.runs r left join public.evaluations e on e.id = r.evaluation_id where r.id = $1 for update of r`,
        [id],
      )).rows[0];
      const evalOnly = prev ? null : (await c.query('select id, owner_wallet from public.evaluations where id = $1', [id])).rows[0];
      if (evalOnly) throw new Error(`conflicting evaluation ${id} for ${e.model_id}: it exists without its run`);
      if (prev && (prev.owner_wallet !== scope.owner || prev.evaluation_id !== id || prev.task_id !== task.id || prev.eval_owner !== scope.owner)) throw new Error(`conflicting run ${id} for ${e.model_id}: owner, task or evaluation link differs`);
      const action: 'inserted' | 'updated' | 'unchanged' = !prev ? 'inserted' : prev.digest === evidence.import_digest ? 'unchanged' : 'updated';
      summary[action]++;
      summary.rows.push({ model: executorKey(e), id, action, score: e.summary.score, runs: e.runs.length, outcome });
      if (action === 'unchanged') continue;

      const valid = e.runs.filter((r) => r.score > 0).length;
      const taskEntry = { taskId: task.id, taskVersionId: tv.id, slug: task.slug, name: task.name, packId: file.task.pack_id, packVersion: file.task.pack_version, isPublic: false, historicalRunId: id, source: 'bench-import' };
      const provenance = { source: 'bench-import', route: e.route, route_name: e.route_name, harness: e.harness, lane: e.lane, cost_basis: e.cost_basis, cost_source: e.cost_source, think: e.think ?? null, effort: e.effort ?? null, ...(e.variant ? { variant: e.variant } : {}), runs: e.runs.length, items: e.summary.items, grader_version: file.grader_version, prompt_sha256: file.prompt_sha256 };
      const runValues = [
        id, release.id, file.task.pack_id, file.task.pack_version, `bench-import-${id}`, outcome, e.ran_from, e.ran_to,
        JSON.stringify(evidence), intOrNull(e.summary.score), version.id, scope.owner, task.id, tv.id,
        e.model_id, e.model_effective, e.route_name, e.summary.cost_total_usd, intOrNull(e.summary.tokens_in_total), intOrNull(e.summary.tokens_out_total),
        dbCostSource(e.cost_source), e.summary.time_per_task_s == null ? null : Math.round(e.summary.time_per_task_s * 1000), JSON.stringify(provenance),
      ];
      const evalValues = [
        id, `bench-${id}`, `B${id.replaceAll('-', '')}`, scope.owner, agent.id, version.id, e.model_id, JSON.stringify([taskEntry]),
        e.summary.score, Number(outcome === 'pass'), Number(outcome === 'fail'), valid, e.runs.length, e.ran_to, e.ran_from,
      ];
      if (action === 'inserted') {
        // The evaluation first: runs.evaluation_id references it.
        await c.query(
          `insert into public.evaluations (id, slug, short_id, owner_wallet, agent_id, agent_version_id, model_id, tasks, status, task_count, payment_kind,
             score, pass_count, fail_count, invalid_count, tests_passed, tests_total, is_public, created_at, started_at, completed_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'graded', 1, 'free_byok', $9, $10, $11, 0, $12, $13, false, $14, $15, $14)`,
          evalValues,
        );
        await c.query(
          `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, started_at, completed_at,
             evidence_manifest, score_total, agent_version_id, owner_wallet, task_id, task_version_id, evaluation_id, seq,
             model_requested, model_effective, model_provider, model_cost_usd, model_tokens_in, model_tokens_out, model_cost_source, wall_ms, provenance)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $1, 1, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
          runValues,
        );
      } else {
        await c.query(
          `update public.evaluations set agent_id = $5, agent_version_id = $6, model_id = $7, tasks = $8, status = 'graded', score = $9,
             pass_count = $10, fail_count = $11, invalid_count = 0, tests_passed = $12, tests_total = $13, created_at = $14, started_at = $15, completed_at = $14
           where id = $1 and slug = $2 and short_id = $3 and owner_wallet = $4`,
          evalValues,
        );
        await c.query(
          `update public.runs set release_declaration_id = $2, status = $6, started_at = $7, completed_at = $8, evidence_manifest = $9, score_total = $10,
             agent_version_id = $11, model_requested = $15, model_effective = $16, model_provider = $17, model_cost_usd = $18,
             model_tokens_in = $19, model_tokens_out = $20, model_cost_source = $21, wall_ms = $22, provenance = $23
           where id = $1 and task_pack_id = $3 and task_pack_version = $4 and nonce = $5 and owner_wallet = $12 and task_id = $13 and task_version_id = $14`,
          runValues,
        );
      }
    }
    await c.query(apply ? 'commit' : 'rollback');
    return summary;
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { email: { type: 'string' }, owner: { type: 'string' }, input: { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!values.email || !values.owner || !values.input) throw new Error('usage: bench-import --email <owner email> --owner <principal id> --input <file | -> [--apply]');
  const text = values.input === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(values.input), 'utf8');
  const file = parseImportFile(JSON.parse(text));
  const repoRoot = resolve(process.env.ITERA_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..', '..'));
  const contract = JSON.parse(readFileSync(join(repoRoot, 'benchmarks', file.task.pack_id, 'task.json'), 'utf8')) as Record<string, unknown>;
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).username.startsWith('itera_api_service')) throw new Error('the existing itera_api_service DB connection is required');
  const { default: pg } = await import('pg');
  const caPath = process.env.ITERA_DB_CA_PATH ?? join(repoRoot, 'apps', 'api', 'certs', 'supabase-pooler-ca-bundle.pem');
  const ssl = process.env.ITERA_DB_SSL === 'disable' ? false : { ca: readFileSync(caPath, 'utf8') };
  const pool = new pg.Pool({ connectionString: url, ssl, max: 1 });
  try {
    console.log(JSON.stringify(await importBench(pool, file, { email: values.email, owner: values.owner, contract }, values.apply)));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'import failed');
    process.exitCode = 1;
  });
}
