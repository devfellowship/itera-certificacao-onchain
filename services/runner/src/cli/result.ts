// The result file of a local run: `tma-local-result/1` (packages/contracts/schemas/local-result.schema.json,
// plan L1). NUMBERS AND IDENTIFIERS ONLY: no action, no patch, no stdout, no model answer, no key, no
// test name. The CLI validates the file with the same validator as the API before it writes it.
import { writeFile } from 'node:fs/promises';
import { isProviderKey, LOCAL_RESULT_FORMAT, providerOf, routeOf, validateLocalResult, type LocalResult } from '@itera/contracts';
import { EVALUATOR_VERSION } from '../../../evaluator/src/runner.js';
import type { EvidenceManifest } from '../../../evaluator/src/types.js';
import type { FinalStatus } from '../jobs.js';
import type { ModelUsage } from '../model-usage.js';
import { CliError } from './env.js';
import type { TaskRef } from './tasks.js';
import { CLI_VERSION } from './version.js';

export type ResultRow = LocalResult['runs'][number] & {
  status: FinalStatus;
  parts: Record<string, number> | null;
  tests: Record<'public_baseline' | 'public_after_patch' | 'hidden', { total: number; passed: number; failed: number }> | null;
};

/** The runner package version (services/runner/package.json): `runner.version` of every result. */
export const RUNNER_VERSION: string = CLI_VERSION;
/** The grader version: the evaluator that computed the score (services/evaluator, the hosted grader). */
export const GRADER_VERSION = EVALUATOR_VERSION;

const PART_KEYS = ['public_behavior', 'hidden_behavior', 'regression', 'patch_integrity_and_scope', 'reproducible_evidence', 'mcp_state'] as const;

function clamp(n: number, max: number): number {
  return Math.min(max, Math.max(0, n));
}

/** The five (or six) score parts of a graded manifest, without the total. */
export function scoreParts(manifest: EvidenceManifest): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of PART_KEYS) {
    const v = manifest.score[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clamp(v, 100);
  }
  return out;
}

/** Test COUNTS of the three suites (never a test name or output). */
export function testCounts(manifest: EvidenceManifest): ResultRow['tests'] {
  const c = (s: { total: number; passed: number; failed: number } | undefined) => ({ total: s?.total ?? 0, passed: s?.passed ?? 0, failed: s?.failed ?? 0 });
  return { public_baseline: c(manifest.tests.public_baseline), public_after_patch: c(manifest.tests.public_after_patch), hidden: c(manifest.tests.hidden) };
}

/** The error class of a row (closed enum), from the run's final status and what stopped it. */
export function errorClass(status: FinalStatus, facts: { timedOut?: boolean; costCapped?: boolean; rateLimited?: boolean; emptyPatch?: boolean }): ResultRow['error_class'] {
  if (facts.costCapped) return 'cost_capped';
  if (status === 'timeout' || facts.timedOut) return 'timeout';
  if (status === 'infra_error') return facts.rateLimited ? 'rate_limited' : 'infra_error';
  if (facts.emptyPatch) return 'empty_output';
  return null;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** One result row. `manifest` null = the grader failed (infra_error, no parts, score 0). */
export function resultRow(input: {
  itemSha256: string;
  repeat: number;
  status: FinalStatus;
  score: number;
  manifest: EvidenceManifest | null;
  wallS: number | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  facts?: Parameters<typeof errorClass>[1];
}): ResultRow {
  return {
    item_sha256: input.itemSha256,
    repeat: input.repeat,
    status: input.status,
    score: clamp(input.score, 100),
    wall_s: input.wallS === null ? null : round(clamp(input.wallS, 86400), 1),
    cost_usd: input.costUsd === null ? null : round(clamp(input.costUsd, 1000), 6),
    tokens_in: input.tokensIn === null ? null : Math.round(clamp(input.tokensIn, 100_000_000)),
    tokens_out: input.tokensOut === null ? null : Math.round(clamp(input.tokensOut, 100_000_000)),
    error_class: errorClass(input.status, input.facts ?? {}),
    parts: input.manifest ? scoreParts(input.manifest) : null,
    tests: input.manifest ? testCounts(input.manifest) : null,
  };
}

/** The tma-score/1 summary of the rows: mean score, pass rate, totals. */
export function summarize(rows: ResultRow[]): LocalResult['summary'] {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const sum = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);
  const known = (pick: (r: ResultRow) => number | null) => rows.map(pick).filter((v): v is number => v !== null);
  const meanOrNull = (xs: number[]) => {
    const m = mean(xs);
    return m === null ? null : round(m, 6);
  };
  const costTotal = sum(known((r) => r.cost_usd));
  return {
    score: round(mean(rows.map((r) => r.score)) ?? 0, 2),
    runs: rows.length,
    items: new Set(rows.map((r) => r.item_sha256)).size,
    pass_rate: rows.length ? round(rows.filter((r) => r.status === 'pass').length / rows.length, 4) : null,
    time_per_task_s: meanOrNull(known((r) => r.wall_s)),
    cost_per_task_usd: meanOrNull(known((r) => r.cost_usd)),
    cost_total_usd: costTotal === null ? null : round(costTotal, 6),
    tokens_in_total: sum(known((r) => r.tokens_in)),
    tokens_out_total: sum(known((r) => r.tokens_out)),
    errors: rows.filter((r) => r.error_class !== null).length,
  };
}

export interface ExecutorInput {
  modelId: string;
  /** A lab key, or null for a custom provider. Default: derived from the model id (labs.json). */
  provider?: string | null;
  /** A route key. Default: derived from the model id (routes.json). */
  route?: string;
  harness: string;
  costSource: LocalResult['executor']['cost_source'];
  modelEffective?: string | null;
}

/** The executor block. Unknown lab → provider null (the API then needs a custom model of the caller). */
export function executorOf(e: ExecutorInput): LocalResult['executor'] {
  const derived = providerOf({ id: e.modelId });
  const provider = e.provider !== undefined ? e.provider : isProviderKey(derived) ? derived : null;
  return {
    model_id: e.modelId,
    provider,
    route: e.route ?? routeOf(e.modelId).key,
    harness: e.harness,
    variant: null,
    cost_source: e.costSource,
    ...(e.modelEffective ? { model_effective: e.modelEffective } : {}),
  };
}

/** The cost source of a sandboxed run, mapped to the closed enum (`unpriced`/`mixed` → `derived`). */
export function costSourceOf(usage: ModelUsage | null): LocalResult['executor']['cost_source'] {
  const s = usage?.costSource;
  if (s === 'metered') return 'metered';
  if (s === 'derived' || s === 'unpriced' || s === 'mixed') return 'derived';
  return 'none';
}

/** Build the result, validate it with the API's own validator, and return it. Throws on a problem. */
export function buildLocalResult(input: {
  agentId: string;
  task: TaskRef;
  runner: LocalResult['runner'];
  executor: LocalResult['executor'];
  ranFrom: Date;
  ranTo: Date;
  rows: ResultRow[];
}): LocalResult {
  const result = {
    format: LOCAL_RESULT_FORMAT,
    agent_id: input.agentId,
    task: input.task,
    metrics_shape: 'tma-score/1' as const,
    grader_version: GRADER_VERSION,
    runner: input.runner,
    executor: input.executor,
    ran_from: input.ranFrom.toISOString(),
    ran_to: input.ranTo.toISOString(),
    summary: summarize(input.rows),
    runs: input.rows,
  };
  const checked = validateLocalResult(result);
  if (!checked.ok) throw new CliError(`the result does not match tma-local-result/1: ${checked.errors.join('; ')}`);
  return checked.value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function checkAgentId(id: string): string {
  if (!UUID.test(id)) throw new CliError(`--agent must be the id (uuid, lowercase) of one of your TestMyAgent agents (got ${id.slice(0, 60)})`);
  return id;
}

/** The table that the user sees after `run` or `grade`: one row per run, then the mean. */
export function resultTable(result: LocalResult): string {
  const rows = result.runs as ResultRow[];
  const head = ['#', 'status', 'score', 'public', 'hidden', 'regress', 'scope', 'evidence', 'wall_s', 'cost_usd', 'cost_src', 'error'];
  const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '-' : String(Math.round(v * 10 ** d) / 10 ** d));
  const lines = rows.map((r, i) => [
    String(i + 1),
    r.status,
    fmt(r.score),
    fmt(r.parts?.public_behavior),
    fmt(r.parts?.hidden_behavior),
    fmt(r.parts?.regression),
    fmt(r.parts?.patch_integrity_and_scope),
    fmt(r.parts?.reproducible_evidence),
    fmt(r.wall_s),
    fmt(r.cost_usd, 4),
    result.executor.cost_source,
    r.error_class ?? '-',
  ]);
  const s = result.summary;
  lines.push(['mean', `${s.runs} run(s)`, fmt(s.score as number, 2), '', '', '', '', '', fmt(s.time_per_task_s as number | null), fmt(s.cost_per_task_usd as number | null, 4), '', `${s.errors} error(s)`]);
  const widths = head.map((h, c) => Math.max(h.length, ...lines.map((l) => l[c]!.length)));
  const line = (cells: string[]) => cells.map((cell, c) => cell.padEnd(widths[c]!)).join('  ').trimEnd();
  return [line(head), ...lines.map(line)].join('\n');
}

/** Write the result file, then print the table. The file holds numbers and identifiers only. */
export async function writeResultFile(path: string, result: LocalResult): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  } catch (err) {
    throw new CliError(`cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
