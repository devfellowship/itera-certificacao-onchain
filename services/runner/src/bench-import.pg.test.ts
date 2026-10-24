/**
 * bench-import against the real schema. Runs when ITERA_PG_TEST_URL points at a Postgres with
 * db/migrations applied (a throwaway database: the test writes its own fixtures and deletes them).
 * Proves: the SQL matches the migrated columns and CHECKs, a second import of the same file writes
 * nothing, a file with more runs updates the same rows, and the owner's task history query (the one
 * `GET /tasks/:id/evaluations` uses) returns one row per executor.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executorRowId, importBench, parseImportFile } from './bench-import.js';

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);
const counts = Object.fromEntries([
  'quotes', 'quotes_literal', 'quotes_artefact', 'quotes_trivial', 'quotes_all_keys', 'quotes_all_keys_literal',
  'corrections_pred', 'corrections_gold', 'corrections_gold_core', 'corrections_matched', 'corrections_core_found',
  'decisions_pred', 'decisions_gold', 'decisions_gold_core', 'decisions_matched', 'decisions_core_found', 'subagent_false_corrections',
].map((k) => [k, 0]));
const run = (repeat: number, score: number) => ({
  item_sha256: H('d'), kind: 'subagent', stratum: 'subagent-small', repeat, present: true, gates: { schema: true, redaction: true }, schema_error_count: 0,
  counts, metrics: { meta_domain: true, meta_type: true, meta_outcome: true, links_f1: 1 }, score, wall_s: 3, cost_usd: null, tokens_in: null, tokens_out: null, error_class: null,
});
const executor = (model_id: string, runs: number, score: number) => ({
  model_id, label: model_id, lane: 'baseline', route: model_id.split('/')[0], route_name: 'Test route', harness: 'test', cost_source: 'none', cost_basis: 'none',
  model_requested: model_id, model_effective: model_id, ran_from: '2026-10-24T10:00:00.000Z', ran_to: '2026-10-24T11:00:00.000Z',
  summary: {
    score, runs, items: 1, schema_valid_rate: 1, quote_literalness_wilson_lb: null, quotes_total: 0, invented_quote_rate: null, redaction_rebuilds: 0,
    correction_recall: null, correction_precision: null, subagent_false_corrections: 0, meta_domain: 1, meta_type: 1, meta_outcome: 1,
    diag_decision_recall: null, diag_decision_precision: null, time_per_task_s: 3, cost_per_task_usd: null, cost_total_usd: null,
    tokens_in_total: null, tokens_out_total: null, errors: 0, gate_schema_q4a: true, gate_quotes_q4a: false,
  },
  runs: Array.from({ length: runs }, (_, i) => run(i + 1, score)),
});

describe.skipIf(!URL_)('bench-import on Postgres', () => {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const tag = randomUUID().slice(0, 8);
  const slug = `bench-import-test-${tag}`;
  const owner = `dfl:${randomUUID()}`;
  const email = `bench-${tag}@example.invalid`;
  const scope = { email, owner, contract: { task: { name: `itera/${slug}`, version: '1' } } };
  const file = (executors: unknown[]) => parseImportFile({
    format: 'tma-bench-import/1', generated_at: '2026-10-24T12:00:00.000Z',
    task: { slug, pack_id: slug, pack_version: '1', name: 'Import test task', description: 'Synthetic.' },
    grader_version: '1.0.0', score_version: 'v2', golden_items: 1, golden_manifest_sha256: H('e'), prompt_sha256: null,
    labels_status: 'synthetic', plan: 'test-plan', executors,
  });

  beforeAll(async () => {
    await pool.query(`insert into public.users (principal_id, email) values ($1, $2)`, [owner, email]);
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'test')`, [slug]);
  });
  afterAll(async () => {
    const ids = (await pool.query(`select id from public.runs where task_pack_id = $1`, [slug])).rows.map((r) => r.id);
    await pool.query(`delete from public.runs where task_pack_id = $1`, [slug]);
    await pool.query(`delete from public.evaluations where id = any($1::uuid[])`, [ids]);
    await pool.query(`delete from public.agents where owner_wallet = $1`, [owner]);
    await pool.query(`delete from public.tasks where slug = $1`, [slug]);
    await pool.query(`delete from public.task_packs where id = $1`, [slug]);
    await pool.query(`delete from public.users where principal_id = $1`, [owner]);
    await pool.end();
  });

  it('previews without writing, imports, re-imports with no change, then updates in place', async () => {
    const first = file([executor('zai/test-a', 2, 50), executor('ollama/test-b', 2, 40)]);
    const preview = await importBench(pool, first, scope, false);
    expect(preview).toMatchObject({ inserted: 2, apply: false });
    expect((await pool.query(`select count(*)::int n from public.tasks where slug = $1`, [slug])).rows[0].n).toBe(0);

    expect(await importBench(pool, first, scope, true)).toMatchObject({ taskCreated: true, versionCreated: true, inserted: 2, updated: 0, unchanged: 0 });
    expect(await importBench(pool, first, scope, true)).toMatchObject({ taskCreated: false, inserted: 0, updated: 0, unchanged: 2 });

    const grown = file([executor('zai/test-a', 3, 55), executor('ollama/test-b', 2, 40), executor('codex/test-c', 1, 70)]);
    expect(await importBench(pool, grown, scope, true)).toMatchObject({ inserted: 1, updated: 1, unchanged: 1 });

    const task = (await pool.query(`select id from public.tasks where slug = $1`, [slug])).rows[0];
    // The owner-scoped history query of GET /tasks/:id/evaluations (evaluations/store.pg.ts listForTaskAndWallet).
    const history = (await pool.query(
      `select e.id, e.model_id, e.score::float as score, e.status, e.tests_total, a.name as agent_name
         from public.evaluations e left join public.agents a on a.id = e.agent_id
        where e.owner_wallet = $1 and exists (select 1 from jsonb_array_elements(e.tasks) t where t ->> 'taskId' = $2 or t ->> 'slug' = $3)
        order by e.model_id`, [owner, task.id, slug])).rows;
    expect(history.map((h) => h.model_id)).toEqual(['codex/test-c', 'ollama/test-b', 'zai/test-a']);
    expect(history.find((h) => h.model_id === 'zai/test-a')).toMatchObject({ id: executorRowId(slug, 'zai/test-a'), score: 55, status: 'graded', tests_total: 3, agent_name: 'bench zai/test-a' });
    const runs = (await pool.query(`select count(*)::int n, sum(jsonb_array_length(evidence_manifest -> 'items'))::int items from public.runs where task_pack_id = $1`, [slug])).rows[0];
    expect(runs).toEqual({ n: 3, items: 6 });
    // Nobody else sees it: another owner's history is empty.
    expect((await pool.query(`select count(*)::int n from public.evaluations where owner_wallet = 'dfl:other' and tasks::text like $1`, [`%${slug}%`])).rows[0].n).toBe(0);
  });

  it('refuses a principal that does not match the email', async () => {
    await expect(importBench(pool, file([executor('zai/test-a', 1, 1)]), { ...scope, owner: 'dfl:not-the-owner' }, true)).rejects.toThrow('expected principal');
  });
});
