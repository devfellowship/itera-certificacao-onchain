/**
 * PgJobStore.finish writes the trajectory columns, runs.infra_ok and the grader rows of a hosted run (plan
 * 20261112-tma-c4-result-store-trajectory-upload, task T4).
 *
 * Part 1 (no database): the 0023 schema probe, with a fake pool. Until 0023 is applied on production the store
 * keeps writing the old shape, so the probe must say "absent", cache "present", and re-ask at most once a minute.
 *
 * Part 2 (Postgres): runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations applied up to
 * 0023 (the web3 e2e guard job sets it). Never point it at a real project. Proves, on the real tables: a hosted
 * run has run_actions rows with `status` and `args_sha256` and one grader_results row (the plan's exit signal);
 * the grader version is a registry row that a second run reuses; an infra_error run has infra_ok = false and no
 * grader row; the old-shape path (probe says absent) writes the old columns only; a trajectory the CHECKs refuse
 * does not lose the run result (the savepoint falls back to the old columns).
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgJobStore, resultTenantFromEnv } from './jobs.pg.js';
import type { RunOutcome } from './jobs.js';
import { parseOpencodeEvents } from './trace.js';

const DIGEST = 'e'.repeat(64);

describe('PgJobStore.hasEvalResultsSchema (the 0023 probe)', () => {
  const fakePool = (answers: Array<unknown[] | Error>) => {
    let calls = 0;
    const pool = {
      query: async () => {
        const a = answers[Math.min(calls, answers.length - 1)]!;
        calls += 1;
        if (a instanceof Error) throw a;
        return { rows: a };
      },
    };
    return { pool: pool as unknown as Pool, calls: () => calls };
  };

  it('is false while the column is absent, asks again after a minute, then caches true', async () => {
    let now = 1_000;
    const f = fakePool([[], [], [{ '?column?': 1 }]]);
    const store = new PgJobStore(f.pool, { now: () => now });
    expect(await store.hasEvalResultsSchema()).toBe(false);
    now = 30_000;
    expect(await store.hasEvalResultsSchema()).toBe(false);
    expect(f.calls()).toBe(1); // inside the minute: not asked again
    now = 62_000;
    expect(await store.hasEvalResultsSchema()).toBe(false);
    now = 123_000;
    expect(await store.hasEvalResultsSchema()).toBe(true);
    now = 999_000;
    expect(await store.hasEvalResultsSchema()).toBe(true);
    expect(f.calls()).toBe(3); // true is cached for the life of the process
  });

  it('a failed probe is "absent", never an error', async () => {
    const store = new PgJobStore(fakePool([new Error('connection reset')]).pool);
    expect(await store.hasEvalResultsSchema()).toBe(false);
  });

  it('the tenant is TMA_RESULT_TENANT when it is a valid key, else the fleet', () => {
    expect(resultTenantFromEnv({})).toBe('devfellowship');
    expect(resultTenantFromEnv({ TMA_RESULT_TENANT: ' acme-corp ' })).toBe('acme-corp');
    expect(resultTenantFromEnv({ TMA_RESULT_TENANT: 'Bad Tenant!' })).toBe('devfellowship');
  });
});

const URL_ = process.env.ITERA_PG_TEST_URL;

describe.skipIf(!URL_)('PgJobStore.finish on Postgres (0023 applied)', () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const tag = `c4t4-${randomUUID().slice(0, 8)}`;
  const OWNER = `wallet-${tag}`;
  const WORKER = `worker-${tag}`;
  const TENANT = 'devfellowship';
  const warnings: Array<Record<string, unknown>> = [];
  const store = new PgJobStore(pool, { tenant: TENANT, warn: (e) => warnings.push(e) });
  /** The old-shape store: the probe says 0023 is absent. */
  class OldShapeStore extends PgJobStore {
    override async hasEvalResultsSchema() {
      return false;
    }
  }
  let vendorId = '';
  let agentId = '';
  let avId = '';
  let rdId = '';
  const runIds: string[] = [];

  const events = () => {
    const tool = (name: string, status: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}, start = 1791814411181) =>
      JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: name, state: { status, input, time: { start, end: start + 40 }, ...extra } } });
    return [
      JSON.stringify({ type: 'step_start', part: {} }),
      tool('read', 'completed', { filePath: '/workspace/src/a.ts' }, { output: 'file text' }),
      tool('bash', 'error', { command: 'npm test' }, { error: 'exit 1' }, 1791814411300),
      JSON.stringify({ type: 'step_finish', part: { tokens: { input: 5, output: 5 }, cost: 0 } }),
      JSON.stringify({ type: 'step_start', part: {} }),
      tool('bash', 'completed', { command: 'npm test' }, { output: 'ok' }, 1791814411400),
    ].join('\n');
  };

  const newRun = async () => {
    const id = randomUUID();
    await pool.query(
      `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, agent_version_id, owner_wallet, worker_id, claimed_at)
       values ($1, $2, $3, '1', $4, 'running', $5, $6, $7, now())`,
      [id, rdId, tag, `${tag}-${runIds.length}`, avId, OWNER, WORKER],
    );
    runIds.push(id);
    return id;
  };

  const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    status: 'pass',
    phase: 'done',
    scoreTotal: 100,
    evidenceManifest: {},
    error: null,
    patch: null,
    actions: parseOpencodeEvents(events()).actions,
    infraOk: true,
    graders: [{ id: 'hidden-tests', semver: '0.3.0', codeSha256: DIGEST, kind: 'code', pass: true, score: 100, weight: 100, hardGate: true, decisive: true }],
    ...over,
  });

  beforeAll(async () => {
    vendorId = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag])).rows[0].id;
    agentId = (
      await pool.query(
        `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
         values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'listed', 'active') returning id`,
        [vendorId, tag, `https://${tag}.example`, OWNER],
      )
    ).rows[0].id;
    avId = (await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb) returning id`, [agentId, 'c'.repeat(40)])).rows[0].id;
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'c4t4-test')`, [tag]);
    rdId = (await pool.query(`insert into public.release_declarations (agent_id, release_ref) values ($1, 'r1') returning id`, [agentId])).rows[0].id;
  });

  afterAll(async () => {
    // grader_results cascade with the run; the grader_versions of this test are removed by their digest.
    await pool.query(`delete from public.runs where owner_wallet = $1`, [OWNER]);
    await pool.query(`delete from public.grader_versions where tenant = $1 and code_sha256 = $2`, [TENANT, DIGEST]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agents where id = $1`, [agentId]);
    await pool.query(`delete from public.vendors where id = $1`, [vendorId]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.end();
  });

  it('a hosted run has run_actions rows with status and args_sha256, infra_ok, and one grader_results row', async () => {
    const runId = await newRun();
    await store.finish(runId, WORKER, outcome());

    const steps = (await pool.query(`select * from public.run_actions where run_id = $1 order by seq`, [runId])).rows;
    expect(steps.map((s) => [s.seq, s.tool, s.status, s.error_class, s.tool_family, s.target_kind, s.turn, s.retry_of])).toEqual([
      [1, 'read', 'ok', null, 'builtin', 'file', 1, null],
      [2, 'bash', 'error', 'tool_error', 'shell', 'command', 1, null],
      [3, 'bash', 'ok', null, 'shell', 'command', 2, 2],
    ]);
    for (const s of steps) expect(s.args_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(steps[0].duration_ms).toBe(40);
    expect(steps[0].result_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The legacy columns are still written the same way.
    expect(steps[0].target).toBe('src/a.ts');
    expect(steps[1].ok).toBe(false);

    const run = (await pool.query(`select status, infra_ok, score_total from public.runs where id = $1`, [runId])).rows[0];
    expect(run).toMatchObject({ status: 'pass', infra_ok: true, score_total: 100 });

    const graders = (
      await pool.query(
        `select gr.tenant, gr.pass, gr.score, gr.weight, gr.hard_gate, gr.decisive, gr.infra_ok, gv.grader_id, gv.semver, gv.kind, gv.code_sha256
           from public.grader_results gr join public.grader_versions gv on gv.id = gr.grader_version_id where gr.run_id = $1`,
        [runId],
      )
    ).rows;
    expect(graders).toHaveLength(1);
    expect(graders[0]).toMatchObject({
      tenant: TENANT, pass: true, hard_gate: true, decisive: true, infra_ok: true, grader_id: 'hidden-tests', semver: '0.3.0', kind: 'code', code_sha256: DIGEST,
    });
    expect(Number(graders[0].score)).toBe(100);
    expect(Number(graders[0].weight)).toBe(100);
    expect(warnings).toEqual([]);
  });

  it('the grader version is one registry row that a second run reuses', async () => {
    const runId = await newRun();
    await store.finish(runId, WORKER, outcome({ status: 'fail', scoreTotal: 90, graders: [{ id: 'hidden-tests', semver: '0.3.0', codeSha256: DIGEST, kind: 'code', pass: false, score: 90, weight: 100, hardGate: true, decisive: true }] }));
    expect((await pool.query(`select count(*)::int as n from public.grader_versions where tenant = $1 and code_sha256 = $2`, [TENANT, DIGEST])).rows[0].n).toBe(1);
    expect((await pool.query(`select count(distinct grader_version_id)::int as n from public.grader_results where run_id = any($1::uuid[])`, [runIds])).rows[0].n).toBe(1);
  });

  it('an infra_error run has infra_ok = false and no grader row', async () => {
    const runId = await newRun();
    await store.finish(runId, WORKER, outcome({ status: 'infra_error', scoreTotal: 0, error: 'grading inconclusive', graders: [], infraOk: false, actions: [] }));
    expect((await pool.query(`select infra_ok from public.runs where id = $1`, [runId])).rows[0].infra_ok).toBe(false);
    expect((await pool.query(`select count(*)::int as n from public.grader_results where run_id = $1`, [runId])).rows[0].n).toBe(0);
  });

  it('with 0023 absent (probe says no) the old columns are written and nothing else', async () => {
    const runId = await newRun();
    await new OldShapeStore(pool).finish(runId, WORKER, outcome());
    const steps = (await pool.query(`select seq, tool, ok, status, args_sha256 from public.run_actions where run_id = $1 order by seq`, [runId])).rows;
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => s.status === null && s.args_sha256 === null)).toBe(true);
    expect((await pool.query(`select infra_ok from public.runs where id = $1`, [runId])).rows[0].infra_ok).toBeNull();
    expect((await pool.query(`select count(*)::int as n from public.grader_results where run_id = $1`, [runId])).rows[0].n).toBe(0);
  });

  it('a trajectory that the CHECKs refuse falls back to the old columns and the run result is still written', async () => {
    const runId = await newRun();
    const bad = outcome();
    // An ok step that names an error class breaks run_actions_status_error_check.
    bad.actions = bad.actions.map((a, i) => (i === 0 ? { ...a, trajectory: { ...a.trajectory!, errorClass: 'tool_error' as const } } : a));
    warnings.length = 0;
    await store.finish(runId, WORKER, bad);
    expect((await pool.query(`select status from public.runs where id = $1`, [runId])).rows[0].status).toBe('pass');
    const steps = (await pool.query(`select seq, status from public.run_actions where run_id = $1 order by seq`, [runId])).rows;
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(steps.every((s) => s.status === null)).toBe(true);
    expect(warnings.map((w) => w.event)).toEqual(['trajectory_write_failed']);
    // The grader row of the same run is still written.
    expect((await pool.query(`select count(*)::int as n from public.grader_results where run_id = $1`, [runId])).rows[0].n).toBe(1);
  });

  it('finish for a run that was re-claimed writes nothing (the guard is unchanged)', async () => {
    const runId = await newRun();
    await store.finish(runId, 'another-worker', outcome());
    expect((await pool.query(`select count(*)::int as n from public.run_actions where run_id = $1`, [runId])).rows[0].n).toBe(0);
    expect((await pool.query(`select count(*)::int as n from public.grader_results where run_id = $1`, [runId])).rows[0].n).toBe(0);
    expect((await pool.query(`select status from public.runs where id = $1`, [runId])).rows[0].status).toBe('running');
  });
});
