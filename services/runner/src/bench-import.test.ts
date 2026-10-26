import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { evidenceOf, executorDigest, executorKey, executorOutcome, executorRowId, importBench, parseImportFile, stableUuid } from './bench-import.js';

// Synthetic fixture: invented numbers and hashes only.
const H = (c: string) => c.repeat(64);
const counts = Object.fromEntries([
  'quotes', 'quotes_literal', 'quotes_artefact', 'quotes_trivial', 'quotes_all_keys', 'quotes_all_keys_literal',
  'corrections_pred', 'corrections_gold', 'corrections_gold_core', 'corrections_matched', 'corrections_core_found',
  'decisions_pred', 'decisions_gold', 'decisions_gold_core', 'decisions_matched', 'decisions_core_found', 'subagent_false_corrections',
].map((k) => [k, 1]));
const run = (repeat: number, score: number) => ({
  item_sha256: H('a'), kind: 'main', stratum: 'main-large', repeat, present: true, gates: { schema: score > 0, redaction: true }, schema_error_count: score > 0 ? 0 : 2,
  counts, metrics: { meta_domain: true, meta_type: false, meta_outcome: true, links_f1: 0.5 }, score, wall_s: 12.5, cost_usd: 0.001, tokens_in: 1000, tokens_out: 100, error_class: null,
});
const summary = (runs: number, over: Record<string, unknown> = {}) => ({
  score: 61.2, runs, items: 1, schema_valid_rate: 0.5, quote_literalness_wilson_lb: 0.2, quotes_total: 2, invented_quote_rate: 0.5, redaction_rebuilds: 0,
  correction_recall: 1, correction_precision: 1, subagent_false_corrections: 0, meta_domain: 1, meta_type: 0, meta_outcome: 1,
  diag_decision_recall: null, diag_decision_precision: null, time_per_task_s: 12.5, cost_per_task_usd: 0.001, cost_total_usd: 0.002,
  tokens_in_total: 2000, tokens_out_total: 200, errors: 0, gate_schema_q4a: false, gate_quotes_q4a: false, ...over,
});
const executor = (model_id: string, over: Record<string, unknown> = {}) => ({
  model_id, label: model_id.split('/')[1], lane: 'zai', route: 'zai', route_name: 'Z.ai API', harness: 'chat completions, one call per item',
  cost_source: 'derived', cost_basis: 'list price x reported tokens', model_requested: model_id.split('/')[1], model_effective: model_id.split('/')[1],
  think: 'disabled', ran_from: '2026-10-24T10:00:00.000Z', ran_to: '2026-10-24T11:00:00.000Z', summary: summary(2), runs: [run(1, 61.2), run(2, 0)], ...over,
});
const file = (executors: unknown[] = [executor('zai/glm-5.3')]) => ({
  format: 'tma-bench-import/1', generated_at: '2026-10-24T12:00:00.000Z',
  task: { slug: 'demo-task', pack_id: 'demo-task', pack_version: '1', name: 'Demo task (private set)', description: 'Synthetic.' },
  grader_version: '1.2.0', score_version: 'v2', golden_items: 1, golden_manifest_sha256: H('b'), prompt_sha256: H('c'),
  labels_status: 'not yet spot-checked', plan: 'demo-plan', executors,
});

describe('bench-import input schema', () => {
  it('accepts numbers, hashes and identifiers', () => {
    const f = parseImportFile(file());
    expect(f.executors[0]!.runs).toHaveLength(2);
    expect(f.executors[0]!.model_id).toBe('zai/glm-5.3');
  });
  it('refuses any key outside the closed schema (a quote, a transcript, a model answer)', () => {
    const withQuote = file([executor('zai/glm-5.3', { runs: [{ ...run(1, 50), quote: 'anything' }, run(2, 0)] })]);
    expect(() => parseImportFile(withQuote)).toThrow(/runs\[0\]\.quote: unknown key/);
    expect(() => parseImportFile({ ...file(), transcript: 'x' })).toThrow(/\$\.transcript: unknown key/);
    const withContent = file([executor('zai/glm-5.3', { content: '{"item_id":1}' })]);
    expect(() => parseImportFile(withContent)).toThrow(/content: unknown key/);
  });
  it('refuses free text in a string field', () => {
    expect(() => parseImportFile(file([executor('zai/glm-5.3', { label: 'line one\nline two' })]))).toThrow(/label/);
    expect(() => parseImportFile(file([executor('zai/glm-5.3', { cost_basis: 'x'.repeat(161) })]))).toThrow(/cost_basis/);
    expect(() => parseImportFile(file([executor('zai/glm-5.3', { harness: 'say "hi" <b>' })]))).toThrow(/harness/);
    expect(() => parseImportFile(file([executor('no-route-prefix')]))).toThrow(/model_id/);
  });
  it('refuses a run count that differs from the list, a duplicate executor and a bad hash', () => {
    expect(() => parseImportFile(file([executor('zai/glm-5.3', { summary: summary(3) })]))).toThrow(/says 3, the list has 2/);
    expect(() => parseImportFile(file([executor('zai/glm-5.3'), executor('zai/glm-5.3')]))).toThrow(/appears twice/);
    expect(() => parseImportFile(file([executor('zai/glm-5.3', { runs: [{ ...run(1, 1), item_sha256: 'abc' }, run(2, 0)] })]))).toThrow(/item_sha256/);
  });
});

describe('bench-import derived values', () => {
  it('gives one stable RFC 4122-shaped id per (task, model)', () => {
    const a = executorRowId('demo-task', 'zai/glm-5.3');
    expect(a).toBe(executorRowId('demo-task', 'zai/glm-5.3'));
    expect(a).not.toBe(executorRowId('demo-task', 'zai/glm-5.1'));
    expect(a).not.toBe(executorRowId('other-task', 'zai/glm-5.3'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableUuid('x')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('passes only when both Q4-A gates hold', () => {
    const f = parseImportFile(file([
      executor('zai/a', { summary: summary(2, { gate_schema_q4a: true, gate_quotes_q4a: true }) }),
      executor('zai/b', { summary: summary(2, { gate_schema_q4a: true, gate_quotes_q4a: false }) }),
    ]));
    expect(f.executors.map(executorOutcome)).toEqual(['pass', 'fail']);
  });
  it('the digest ignores the generation time and changes with the numbers', () => {
    const a = parseImportFile(file());
    const b = parseImportFile({ ...file(), generated_at: '2026-10-25T00:00:00.000Z' });
    const c = parseImportFile(file([executor('zai/glm-5.3', { summary: summary(2, { score: 62 }) })]));
    expect(executorDigest(a, a.executors[0]!)).toBe(executorDigest(b, b.executors[0]!));
    expect(executorDigest(a, a.executors[0]!)).not.toBe(executorDigest(c, c.executors[0]!));
  });
});

/** A fake connection that answers the import's SELECTs from a small in-memory state. */
function fakeDb(opts: { principal?: boolean; pack?: boolean; existingDigest?: string | null; agentOwner?: string | null; runOwner?: string }) {
  const sqls: string[] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    sqls.push(s);
    if (s.startsWith('select principal_id')) return { rows: opts.principal === false ? [] : [{ principal_id: values[1] }] };
    if (s.startsWith('select id, version from public.task_packs')) return { rows: opts.pack === false ? [] : [{ id: values[0], version: values[1] }] };
    if (s.startsWith('select id, slug, kind')) return { rows: [] };
    if (s.startsWith('insert into public.tasks')) return { rows: [{ id: 'task-1', slug: values[0], name: values[2] }] };
    if (s.startsWith('select id, source, pack_id')) return { rows: [] };
    if (s.startsWith('insert into public.task_versions')) return { rows: [{ id: 'tv-1' }] };
    if (s.startsWith('select id from public.vendors')) return { rows: [{ id: 'vendor-1' }] };
    if (s.startsWith('select id, owner_wallet from public.agents')) return { rows: opts.agentOwner === undefined ? [] : [{ id: 'agent-1', owner_wallet: opts.agentOwner }] };
    if (s.startsWith('insert into public.agents')) return { rows: [{ id: 'agent-1' }] };
    if (s.startsWith('insert into public.agent_versions')) return { rows: [{ id: 'av-1' }] };
    if (s.startsWith('insert into public.release_declarations')) return { rows: [{ id: 'rd-1' }] };
    if (s.startsWith('select r.owner_wallet')) {
      if (opts.existingDigest === undefined) return { rows: [] };
      return { rows: [{ owner_wallet: opts.runOwner ?? 'dfl:owner', evaluation_id: values[0], task_id: 'task-1', digest: opts.existingDigest, eval_owner: opts.runOwner ?? 'dfl:owner' }] };
    }
    if (s.startsWith('select id, owner_wallet from public.evaluations')) return { rows: [] };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  return { pool: { connect: async () => ({ query, release }) } as unknown as Pool, sqls, release };
}
const scope = { email: 'owner@example.com', owner: 'dfl:owner', contract: { task: { version: '1' } } };

describe('bench-import transaction', () => {
  it('rolls back before any write when the email does not identify the principal', async () => {
    const db = fakeDb({ principal: false });
    await expect(importBench(db.pool, parseImportFile(file()), scope, true)).rejects.toThrow('expected principal');
    expect(db.sqls.some((s) => s.startsWith('insert') || s.startsWith('update'))).toBe(false);
    expect(db.sqls.at(-1)).toBe('rollback');
    expect(db.release).toHaveBeenCalledOnce();
  });
  it('refuses an unregistered task pack', async () => {
    const db = fakeDb({ pack: false });
    await expect(importBench(db.pool, parseImportFile(file()), scope, true)).rejects.toThrow('is not registered');
    expect(db.sqls.some((s) => s.startsWith('insert'))).toBe(false);
  });
  it('inserts task, version, agent and one evaluation + run per executor; preview rolls back', async () => {
    const db = fakeDb({});
    const f = parseImportFile(file([executor('zai/glm-5.3'), executor('ollama/gemma4:12b', { lane: 'alien', route: 'ollama', route_name: 'Local Ollama' })]));
    const out = await importBench(db.pool, f, scope, false);
    expect(out).toMatchObject({ apply: false, taskCreated: true, versionCreated: true, executors: 2, inserted: 2, updated: 0, unchanged: 0 });
    expect(out.rows.map((r) => r.id)).toEqual([executorRowId('demo-task', 'zai/glm-5.3'), executorRowId('demo-task', 'ollama/gemma4:12b')]);
    expect(db.sqls.filter((s) => s.startsWith('insert into public.evaluations'))).toHaveLength(2);
    expect(db.sqls.filter((s) => s.startsWith('insert into public.runs'))).toHaveLength(2);
    // the evaluation goes in before its run (runs.evaluation_id references it)
    expect(db.sqls.findIndex((s) => s.startsWith('insert into public.evaluations'))).toBeLessThan(db.sqls.findIndex((s) => s.startsWith('insert into public.runs')));
    expect(db.sqls.at(-1)).toBe('rollback');
  });
  it('a re-run with the same numbers writes no evaluation and no run (idempotent)', async () => {
    const f = parseImportFile(file());
    const db = fakeDb({ existingDigest: executorDigest(f, f.executors[0]!), agentOwner: 'dfl:owner' });
    const out = await importBench(db.pool, f, scope, true);
    expect(out).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(db.sqls.some((s) => /^(insert into|update) public\.(evaluations|runs)/.test(s))).toBe(false);
    expect(db.sqls.at(-1)).toBe('commit');
  });
  it('a re-run with more runs updates the same rows in place', async () => {
    const db = fakeDb({ existingDigest: 'old', agentOwner: null });
    const out = await importBench(db.pool, parseImportFile(file()), scope, true);
    expect(out).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
    expect(db.sqls.filter((s) => s.startsWith('update public.evaluations'))).toHaveLength(1);
    expect(db.sqls.filter((s) => s.startsWith('update public.runs'))).toHaveLength(1);
    expect(db.sqls.some((s) => s.startsWith('insert into public.runs'))).toBe(false);
  });
  it('refuses an agent or a run of another owner', async () => {
    await expect(importBench(fakeDb({ agentOwner: 'dfl:someone-else' }).pool, parseImportFile(file()), scope, true)).rejects.toThrow('another owner');
    await expect(importBench(fakeDb({ existingDigest: 'old', runOwner: 'dfl:someone-else' }).pool, parseImportFile(file()), scope, true)).rejects.toThrow('conflicting run');
  });
});


// The session-decision-trajectory shape (format tma-bench-import/trajectory-1). Synthetic numbers only.
const checks = (gatesOk: boolean) => ({
  schema: gatesOk, intents_closed: gatesOk, risk_floor: gatesOk, speaker: gatesOk, outcome_consistent: gatesOk,
  class_match: gatesOk, risk_match: false, intent_agreement: gatesOk, corrections: gatesOk,
});
const tRun = (repeat: number, score: number) => ({
  item_sha256: H('a'), kind: 'subagent', repeat, present: true, checks: checks(score > 0),
  metrics: score > 0 ? { class_match: 1, risk_match: null, intent_agreement: 0.5, corrections: null, corrections_recall: null, corrections_precision: null, class_type: true, class_subtype: null } : null,
  score, wall_s: 8.1, cost_usd: null, tokens_in: 6500, tokens_out: 334, error_class: null,
});
const tSummary = (runs: number, over: Record<string, unknown> = {}) => ({
  score: 50, runs, items: 1, gate_pass_rate: 0.5, check_pass_rate: 0.39, mean_score_when_gates_pass: 100,
  gate_fail_schema: 1, gate_fail_intents_closed: 1, gate_fail_risk_floor: 1, gate_fail_speaker: 1, gate_fail_outcome_consistent: 1,
  metric_class_match: 1, metric_risk_match: null, metric_intent_agreement: 0.5, metric_corrections: null,
  time_per_task_s: 8.1, items_per_hour: 444, cost_per_task_usd: null, cost_total_usd: null, tokens_in_total: 13000, tokens_out_total: 668, errors: 0, ...over,
});
const tExecutor = (model_id: string, over: Record<string, unknown> = {}) => ({
  ...executor(model_id, { lane: 'alien', route: 'ollama', route_name: 'Local Ollama (alien01)', cost_source: 'none', cost_basis: 'hardware owned' }),
  summary: tSummary(2), runs: [tRun(1, 100), tRun(2, 0)], ...over,
});
const tFile = (executors: unknown[] = [tExecutor('ollama/gemma4:26b')]) => ({ ...file(), format: 'tma-bench-import/trajectory-1', executors });

describe('bench-import trajectory shape', () => {
  it('accepts the 9 checks, the metric numbers and a structured-output variant of the same model', () => {
    const f = parseImportFile(tFile([tExecutor('ollama/gemma4:26b'), tExecutor('ollama/gemma4:26b', { variant: 'structured-output' })]));
    expect(f.format).toBe('tma-bench-import/trajectory-1');
    expect(f.executors.map(executorKey)).toEqual(['ollama/gemma4:26b', 'ollama/gemma4:26b#structured-output']);
    expect(executorRowId('demo-task', 'ollama/gemma4:26b')).not.toBe(executorRowId('demo-task', executorKey(f.executors[1]!)));
  });
  it('refuses a mining run in a trajectory file, a gate error text and an unknown variant', () => {
    expect(() => parseImportFile(tFile([tExecutor('ollama/a', { runs: [run(1, 50), run(2, 0)] })]))).toThrow(/unknown key|is required/);
    expect(() => parseImportFile(tFile([tExecutor('ollama/a', { runs: [{ ...tRun(1, 0), gate_errors: { schema: ['x'] } }, tRun(2, 0)] })]))).toThrow(/gate_errors: unknown key/);
    expect(() => parseImportFile(tFile([tExecutor('ollama/a', { runs: [{ ...tRun(1, 0), item_id: 'abc' }, tRun(2, 0)] })]))).toThrow(/item_id: unknown key/);
    expect(() => parseImportFile(tFile([tExecutor('ollama/a', { variant: 'free text' })]))).toThrow(/variant/);
    expect(() => parseImportFile(tFile([tExecutor('ollama/a'), tExecutor('ollama/a')]))).toThrow(/appears twice/);
    expect(() => parseImportFile({ ...file(), format: 'tma-bench-import/9' })).toThrow(/format/);
  });
  it('a mining file still refuses the trajectory run shape', () => {
    expect(() => parseImportFile(file([executor('zai/a', { runs: [tRun(1, 1), tRun(2, 0)] })]))).toThrow(/unknown key|is required/);
  });
  it('passes only when at least 95% of the runs pass all 5 rule gates', () => {
    const f = parseImportFile(tFile([
      tExecutor('ollama/a', { summary: tSummary(2, { gate_pass_rate: 0.95 }) }),
      tExecutor('ollama/b', { summary: tSummary(2, { gate_pass_rate: 0.8 }) }),
    ]));
    expect(f.executors.map(executorOutcome)).toEqual(['pass', 'fail']);
    expect(evidenceOf(f, f.executors[0]!)).toMatchObject({ kind: 'tma-bench-import/trajectory-1', outcome_rule: expect.stringContaining('gate_pass_rate') });
  });
  it('writes one evaluation row per (model, variant), named by the variant', async () => {
    const db = fakeDb({});
    const f = parseImportFile(tFile([tExecutor('ollama/gemma4:26b'), tExecutor('ollama/gemma4:26b', { variant: 'structured-output' })]));
    const out = await importBench(db.pool, f, scope, false);
    expect(out).toMatchObject({ inserted: 2, executors: 2 });
    expect(new Set(out.rows.map((r) => r.id)).size).toBe(2);
    expect(db.sqls.filter((s) => s.startsWith('insert into public.evaluations'))).toHaveLength(2);
    expect(db.sqls.at(-1)).toBe('rollback');
  });
  it('a mining file keeps its v1 row ids and digests (no variant)', () => {
    const f = parseImportFile(file());
    expect(executorKey(f.executors[0]!)).toBe('zai/glm-5.3');
    expect(evidenceOf(f, f.executors[0]!).kind).toBe('tma-bench-import/1');
  });
});
