// `tma route nightly` end to end with fakes (plan 20261112-tma-c8-routing-from-evals, T6). A tiny golden dir in a
// temp folder, the example live route of examples/route/, a fake fetch for /routes, /eval-runs, /eval-cases and
// PATCH, and a fake RunGolden with scripted scores: no model call, no paid run, no sandbox.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { AGENT, API, H, TOKEN, captureIo, tempEnv } from '../test/fixtures.js';
import { validateNightlyState, type GoldenRun } from '../route/nightly.js';
import type { RunGolden, RunGoldenInput, RunGoldenResult } from '../route/nightly-run.js';
import { makeRouteCommand } from './route.js';

const EX = resolve(import.meta.dirname, '../../../examples/route');
const LIVE = JSON.parse(readFileSync(join(EX, 'route.live.json'), 'utf-8')) as Record<string, any>;
const ID = LIVE.id as string;
const ID2 = '9d2f4b10-5c6e-4a7b-8c9d-0e1f2a3b4c5d';
const UC = LIVE.use_case_key as string; // content/report-html
const NOW = Date.parse('2026-11-13T03:00:00Z');
const EV1 = LIVE.evidence_run_ids[0] as string;
const EV2 = LIVE.evidence_run_ids[1] as string;
const CASE1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const CASE2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const EV_PIN = H('e');
const PAID = 'z-ai/glm-5.3';
const TIERS = JSON.stringify({ schema: 'tma-model-tiers/1', models: [{ model_id: PAID, tier: 'mid', price_source: 'metered' }] });

/** The example live route as the API answers it (tma-route/2). */
function route(over: Record<string, unknown> = {}) {
  return { ...LIVE, format: 'tma-route/2', live_at: '2026-11-13T10:00:00Z', rollback_pr_url: null, rolled_back_at: null, ...over };
}

function loggedIn(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...tempEnv(), TMA_BUDGET_NIGHT: '1000', TMA_BUDGET_MONTH: '1000', ...extra };
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

interface GoldenOpts {
  keys?: string[];
  rows?: Array<Record<string, unknown>>;
  pin?: Record<string, string>;
  task?: Record<string, string>;
  profile?: Record<string, unknown>;
  noFile?: boolean;
}

function caseJson(key: string, pin: string | null, task = `tsk_golden_${key.replace(/-/g, '_')}@1`) {
  return {
    schema: 'tma-case/1',
    case_key: key,
    use_case: UC,
    mode: 'replay',
    answer_shape: 'single',
    pin: pin === null ? null : { pin_sha256: pin, record: { schema: 'tma-pin/1' } },
    task_ref: { kind: 'tma-task', id: task },
    expected: { text: 'A report page.', written_by: 'tainan', written_at: '2026-11-12T10:00:00Z' },
    graders: [{ id: 'hidden-tests', version: '1.0.0', weight: 1, hard_gate: true }],
    split: 'golden',
    source: 'synthetic',
  };
}

/** A tiny dfl-evals checkout: sets/golden/<uc>.jsonl, cases/<uc>/<key>/case.json, use-cases/<uc>/profile.json. */
function goldenDir(o: GoldenOpts = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'tma-golden-'));
  const keys = o.keys ?? ['golden-a', 'golden-b'];
  const rows = o.rows ?? [{ note: 'a legacy row, ignored' }, ...keys.map((k) => ({ schema: 'tma-golden-row/1', case_key: k, state: 'approved', approved_by: 'tainan' }))];
  if (!o.noFile) {
    const f = join(dir, 'sets', 'golden', `${UC}.jsonl`);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  for (const k of keys) {
    const f = join(dir, 'cases', UC, k, 'case.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(caseJson(k, o.pin?.[k] ?? H(String(keys.indexOf(k) + 1)), o.task?.[k])));
  }
  if (o.profile) {
    const f = join(dir, 'use-cases', UC, 'profile.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(o.profile));
  }
  return dir;
}

interface ApiOpts {
  routes?: unknown[];
  paid?: number;
  runs?: unknown[];
  cases?: unknown[];
  patchStatus?: number;
}

/** A fake API. /eval-runs answers the two evidence runs (fleet Claude, free) plus `paid` paid runs. */
function fakeApi(o: ApiOpts = {}) {
  const evidence = [
    { id: EV1, startedAt: '2026-11-10T10:00:00Z', caseId: CASE1, caseKey: 'evidence-one', variant: { agent: { modelId: 'claude-sonnet-5-5' } } },
    { id: EV2, startedAt: '2026-11-10T11:00:00Z', caseId: CASE2, caseKey: 'evidence-two', variant: { agent: { modelId: 'claude-sonnet-5-5' } } },
  ];
  const paidRows = Array.from({ length: o.paid ?? 0 }, (_, i) => ({ id: `p${i}`, startedAt: '2026-11-01T10:00:00Z', caseId: CASE1, caseKey: 'evidence-one', variant: { agent: { modelId: PAID } } }));
  const cases = o.cases ?? [
    { id: CASE1, caseKey: 'evidence-one', originPinSha256: EV_PIN, taskSlug: 'tsk_evidence' },
    { id: CASE2, caseKey: 'evidence-two', originPinSha256: null, taskSlug: 'tsk_evidence' },
  ];
  return vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (init.method === 'PATCH') return new Response(JSON.stringify({ id: ID, state: 'needs_check' }), { status: o.patchStatus ?? 200 });
    if (u.pathname === '/routes') return new Response(JSON.stringify({ routes: o.routes ?? [route()] }), { status: 200 });
    if (u.pathname === '/eval-runs') return new Response(JSON.stringify({ runs: o.runs ?? [...evidence, ...paidRows], limit: 500, truncated: false }), { status: 200 });
    if (u.pathname === '/eval-cases') return new Response(JSON.stringify({ cases, limit: 200, truncated: false }), { status: 200 });
    if (u.pathname === '/self-declared-results') throw new Error('the nightly must upload through RunGolden only');
    return new Response('{}', { status: 404 });
  });
}

/** A fake RunGolden: every case gets `repeat` runs with the scripted scores (cycled). */
function fakeRun(scores: number[], over: Partial<RunGoldenResult> = {}) {
  return vi.fn(async (input: RunGoldenInput): Promise<RunGoldenResult> => {
    const runs: GoldenRun[] = [];
    let i = 0;
    for (const c of input.cases) for (let n = 0; n < input.repeat; n++) runs.push({ case_key: c.case_key, score: scores[i++ % scores.length]!, hardGatesOk: true, infraOk: true });
    return { runs, unuploadedRuns: 0, uploadFailed: false, errors: [], ...over };
  });
}

function files(stateText: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'tma-nightly-'));
  const tiers = join(dir, 'tiers.json');
  writeFileSync(tiers, TIERS);
  const state = join(dir, 'state.json');
  if (stateText !== null) writeFileSync(state, stateText);
  mkdirSync(join(dir, 'agent'));
  return { dir, tiers, state };
}

async function nightly(o: { golden?: string; api?: ReturnType<typeof fakeApi>; run?: RunGolden; extra?: string[]; stateText?: string | null; env?: NodeJS.ProcessEnv; f?: ReturnType<typeof files> } = {}) {
  const f = o.f ?? files(o.stateText ?? null);
  const fetchImpl = o.api ?? fakeApi();
  const runGolden = o.run ?? fakeRun([96]);
  const io = captureIo();
  const argv = ['nightly', '--golden-dir', o.golden ?? goldenDir(), '--tiers', f.tiers, '--agent-dir', join(f.dir, 'agent'), '--work-dir', join(f.dir, 'work'), '--state', f.state, '--agent', AGENT, ...(o.extra ?? [])];
  const code = await makeRouteCommand({ env: o.env ?? loggedIn(), fetchImpl: fetchImpl as never, now: () => NOW, runGolden }).main(argv, io);
  const state = existsSync(f.state) ? JSON.parse(readFileSync(f.state, 'utf-8')) : null;
  return { code, out: io.outText(), err: io.errText(), fetchImpl, runGolden, state, f };
}

const patches = (f: ReturnType<typeof fakeApi>) => f.mock.calls.filter(([, init]) => init.method === 'PATCH').map(([url, init]) => ({ url, body: JSON.parse(String(init.body)) }));
const summaryLine = (out: string) => out.split('\n').at(-1)!;

describe('tma route nightly: absolute rule', () => {
  it('a seeded drop (cited same, tonight 70) marks exactly one route needs_check', async () => {
    const r = await nightly({ run: fakeRun([70]) });
    expect(r.code).toBe(0);
    expect(patches(r.fetchImpl)).toEqual([{ url: `${API}/routes/${ID}/state`, body: { state: 'needs_check' } }]);
    expect(r.out).toContain(`route ${ID} ${UC}: needs_check (nightly_drop: absolute NOT YET tonight, cited same) marked`);
    expect(summaryLine(r.out)).toBe('nightly status=ok routes=1 ran=1 dropped=1 marked=1 skipped=0 paid_planned=0 paid_total=0/200');
    expect(r.runGolden).toHaveBeenCalledOnce();
    expect(r.state.routes[ID].last_label).toBe('NOT YET');
  });
  it('the same route above the bar is not marked', async () => {
    const r = await nightly({ run: fakeRun([96]) });
    expect(r.code).toBe(0);
    expect(patches(r.fetchImpl)).toEqual([]);
    expect(r.out).toContain(`route ${ID} ${UC}: ok (absolute SAME tonight, cited same)`);
  });
  it('CLOSE passes; the profile bars are read from use-cases/<uc>/profile.json', async () => {
    const close = await nightly({ run: fakeRun([90]) });
    expect(patches(close.fetchImpl)).toEqual([]);
    expect(close.out).toContain('absolute CLOSE tonight');
    const strict = await nightly({ run: fakeRun([90]), golden: goldenDir({ profile: { absolute_bars: { same: 99, close: 95 } } }) });
    expect(patches(strict.fetchImpl)).toHaveLength(1);
  });
  it('exactly at the CLOSE bar (85) passes; one point under is a drop', async () => {
    expect(patches((await nightly({ run: fakeRun([85]) })).fetchImpl)).toEqual([]);
    expect(patches((await nightly({ run: fakeRun([84]) })).fetchImpl)).toHaveLength(1);
  });
  it('a failed hard gate is a drop even with a high score', async () => {
    const run = vi.fn(async (input: RunGoldenInput): Promise<RunGoldenResult> => ({
      runs: input.cases.flatMap((c) => Array.from({ length: input.repeat }, (_, n) => ({ case_key: c.case_key, score: 99, hardGatesOk: n !== 0, infraOk: true }))),
      unuploadedRuns: 0, uploadFailed: false, errors: [],
    }));
    const r = await nightly({ run });
    expect(patches(r.fetchImpl)).toHaveLength(1);
    expect(r.out).toContain('absolute NOT YET tonight');
  });
  it('too few runs is no verdict and no mark (n_below_minimum)', async () => {
    const r = await nightly({ run: fakeRun([10]), extra: ['--repeat', '2'] }); // 2 cases x 2 = 4 < 5
    expect(r.code).toBe(0);
    expect(patches(r.fetchImpl)).toEqual([]);
    expect(r.out).toContain('no verdict (n_below_minimum (n=4, min 5))');
  });
});

describe('tma route nightly: relative rule', () => {
  const rel = () => fakeApi({ routes: [route({ picked_rule: 'relative', verdict: 'same' })] });
  it('night 1 records the baseline, night 2 with a worse sample marks', async () => {
    const f = files();
    const n1 = await nightly({ f, api: rel(), run: fakeRun([80, 81, 82]) });
    expect(n1.code).toBe(0);
    expect(patches(n1.fetchImpl)).toEqual([]);
    expect(n1.out).toContain('baseline_recorded (relative baseline recorded, n=6)');
    expect(n1.state.routes[ID].baseline).toEqual({ 'golden-a': [80, 81, 82], 'golden-b': [80, 81, 82] });
    const n2 = await nightly({ f, api: rel(), run: fakeRun([40, 41, 42]) });
    expect(n2.code).toBe(0);
    expect(patches(n2.fetchImpl)).toHaveLength(1);
    expect(n2.out).toContain('needs_check (nightly_drop: relative worse tonight, cited same) marked');
    expect(n2.state.routes[ID].baseline).toEqual(n1.state.routes[ID].baseline);
  });
  it('night 2 with the same sample does not mark', async () => {
    const f = files();
    await nightly({ f, api: rel(), run: fakeRun([80, 81, 82]) });
    const n2 = await nightly({ f, api: rel(), run: fakeRun([80, 81, 82]) });
    expect(patches(n2.fetchImpl)).toEqual([]);
    expect(n2.out).toContain('ok (relative tie tonight, cited same)');
  });
});

describe('tma route nightly: held-out proof', () => {
  it('a golden case_key equal to an evidence case key skips the route; RunGolden is not called', async () => {
    const r = await nightly({ golden: goldenDir({ keys: ['golden-a', 'evidence-one'] }) });
    expect(r.code).toBe(0);
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.out).toContain(`route ${ID} ${UC}: skipped (golden_not_held_out: evidence-one (case_key))`);
  });
  it('a golden pin_sha256 equal to an evidence originPinSha256 skips the route', async () => {
    const r = await nightly({ golden: goldenDir({ pin: { 'golden-b': EV_PIN } }) });
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.out).toContain('skipped (golden_not_held_out: golden-b (pin_sha256))');
  });
  it('a golden task equal to an evidence task skips the route', async () => {
    const r = await nightly({ golden: goldenDir({ task: { 'golden-a': 'tsk_evidence@1' } }) });
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.out).toContain('skipped (golden_not_held_out: golden-a (task_ref))');
  });
  it('an evidence run that the reader cannot see skips the route (fail closed)', async () => {
    const r = await nightly({ api: fakeApi({ runs: [] }) });
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.out).toContain(`skipped (held_out_unprovable: evidence run ${EV1.slice(0, 8)} is not in the run rows)`);
  });
  it('an evidence case that /eval-cases does not list skips the route', async () => {
    const r = await nightly({ api: fakeApi({ cases: [] }) });
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.out).toContain('skipped (held_out_unprovable: the case of evidence run');
  });
});

describe('tma route nightly: golden set', () => {
  it('a draft row refuses the set (golden_draft); RunGolden is not called', async () => {
    const rows = [
      { schema: 'tma-golden-row/1', case_key: 'golden-a', state: 'approved', approved_by: 'tainan' },
      { schema: 'tma-golden-row/1', case_key: 'golden-b', state: 'draft', approved_by: null },
    ];
    const r = await nightly({ golden: goldenDir({ rows }) });
    expect(r.code).toBe(0);
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.out).toContain('skipped (golden_draft: golden-b)');
  });
  it('no golden file -> no_golden_set', async () => {
    const r = await nightly({ golden: goldenDir({ noFile: true }) });
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.out).toContain('skipped (no_golden_set)');
    expect(summaryLine(r.out)).toBe('nightly status=ok routes=1 ran=0 dropped=0 marked=0 skipped=1 paid_planned=0 paid_total=0/200');
  });
  it('only legacy rows -> no_golden_set', async () => {
    const r = await nightly({ golden: goldenDir({ rows: [{ case_key: 'golden-a' }] }) });
    expect(r.out).toContain('skipped (no_golden_set)');
  });
  it('a case that is not split golden -> golden_case_invalid', async () => {
    const g = goldenDir();
    const f = join(g, 'cases', UC, 'golden-a', 'case.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf-8')), split: 'calibration-test' }));
    const r = await nightly({ golden: g });
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.out).toContain('skipped (golden_case_invalid: golden-a split is calibration-test, not golden)');
  });
});

describe('tma route nightly: budget', () => {
  const paidRoute = (over: Record<string, unknown> = {}) => route({ model_id: PAID, ...over });
  const one = () => goldenDir({ keys: ['golden-a'] });
  it('199 paid + 1 planned runs', async () => {
    const r = await nightly({ golden: one(), api: fakeApi({ routes: [paidRoute()], paid: 199 }), extra: ['--repeat', '1'] });
    expect(r.runGolden).toHaveBeenCalledOnce();
    expect(summaryLine(r.out)).toContain('paid_planned=1 paid_total=200/200');
  });
  it('200 paid + 1 planned is refused: RunGolden not called, exit 2', async () => {
    const r = await nightly({ golden: one(), api: fakeApi({ routes: [paidRoute()], paid: 200 }), extra: ['--repeat', '1'] });
    expect(r.code).toBe(2);
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.out).toContain('skipped (budget_refused: total_cap: have 200, planned 1, cap 200)');
    expect(summaryLine(r.out)).toBe('nightly status=refused routes=1 ran=0 dropped=0 marked=0 skipped=1 paid_planned=0 paid_total=200/200');
  });
  it('a free (fleet Claude) route is never refused, however many paid runs exist', async () => {
    const r = await nightly({ api: fakeApi({ paid: 450 }) });
    expect(r.code).toBe(0);
    expect(r.runGolden).toHaveBeenCalledOnce();
  });
  it('the unuploaded paid runs of the state count', async () => {
    const st = (n: number) => JSON.stringify({ format: 'tma-route-nightly-state/1', routes: {}, unuploaded_paid_runs: n });
    const bad = await nightly({ golden: one(), api: fakeApi({ routes: [paidRoute()], paid: 195 }), stateText: st(5), extra: ['--repeat', '1'] });
    expect(bad.code).toBe(2);
    expect(bad.runGolden).not.toHaveBeenCalled();
    expect(bad.out).toContain('total_cap: have 200, planned 1, cap 200');
    const ok = await nightly({ golden: one(), api: fakeApi({ routes: [paidRoute()], paid: 195 }), stateText: st(4), extra: ['--repeat', '1'] });
    expect(ok.code).toBe(0);
    expect(ok.runGolden).toHaveBeenCalledOnce();
  });
  it('two routes in one night share the cap', async () => {
    const r = await nightly({ golden: one(), api: fakeApi({ routes: [paidRoute(), paidRoute({ id: ID2 })], paid: 197 }), extra: ['--repeat', '2'] });
    expect(r.code).toBe(2);
    expect(r.runGolden).toHaveBeenCalledOnce();
    expect(r.out).toContain(`route ${ID2} ${UC}: skipped (budget_refused: total_cap: have 199, planned 2, cap 200)`);
    expect(summaryLine(r.out)).toBe('nightly status=refused routes=2 ran=1 dropped=0 marked=0 skipped=1 paid_planned=2 paid_total=199/200');
  });
  it('the default night cap (10) also applies', async () => {
    const r = await nightly({ golden: one(), api: fakeApi({ routes: [paidRoute()] }), env: loggedIn({ TMA_BUDGET_NIGHT: '' }), extra: ['--repeat', '1'] });
    expect(r.code).toBe(0);
    const big = await nightly({ golden: goldenDir(), api: fakeApi({ routes: [paidRoute()] }), env: loggedIn({ TMA_BUDGET_NIGHT: '5' }), extra: ['--repeat', '3'] });
    expect(big.code).toBe(2);
    expect(big.out).toContain('night_cap: have 0, planned 6, cap 5');
  });
});

describe('tma route nightly: flags, state, failures', () => {
  it('--skip-local skips a local-model route', async () => {
    const r = await nightly({ api: fakeApi({ routes: [route({ model_id: 'ollama/qwen3-coder' })] }), extra: ['--skip-local'] });
    expect(r.code).toBe(0);
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.out).toContain('skipped (local_model_host_down)');
    const without = await nightly({ api: fakeApi({ routes: [route({ model_id: 'ollama/qwen3-coder' })] }) });
    expect(without.runGolden).toHaveBeenCalledOnce();
  });
  it('--dry-run runs nothing, sends no PATCH and no upload, and still writes the state', async () => {
    const r = await nightly({ run: fakeRun([70]), extra: ['--dry-run'] });
    expect(r.code).toBe(0);
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(patches(r.fetchImpl)).toEqual([]);
    expect(r.out).toContain(`route ${ID} ${UC}: would run 2 case(s) x 3 (paid 0) (dry run)`);
    expect(r.state).toEqual({ format: 'tma-route-nightly-state/1', routes: {}, unuploaded_paid_runs: 0 });
    expect(validateNightlyState(r.state).ok).toBe(true);
  });
  it('--dry-run needs no --agent; a real run does', async () => {
    const f = files();
    const io = captureIo();
    const base = ['nightly', '--golden-dir', goldenDir(), '--tiers', f.tiers, '--agent-dir', f.dir, '--work-dir', f.dir, '--state', f.state];
    const cmd = makeRouteCommand({ env: loggedIn(), fetchImpl: fakeApi() as never, now: () => NOW, runGolden: fakeRun([96]) });
    expect(await cmd.main(base, io)).toBe(2);
    expect(io.errText()).toContain('--agent is required');
    expect(await cmd.main([...base, '--dry-run'], captureIo())).toBe(0);
  });
  it('a corrupt state file is refused (exit 2) and left untouched', async () => {
    const r = await nightly({ stateText: '{"format":"tma-route-nightly-state/1","routes":{}}' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('is not a tma-route-nightly-state/1 file');
    expect(readFileSync(r.f.state, 'utf-8')).toBe('{"format":"tma-route-nightly-state/1","routes":{}}');
    expect(r.runGolden).not.toHaveBeenCalled();
    expect(r.fetchImpl).not.toHaveBeenCalled();
  });
  it('an upload failure sets unuploaded_paid_runs and exits 3', async () => {
    const r = await nightly({
      golden: goldenDir({ keys: ['golden-a'] }),
      api: fakeApi({ routes: [route({ model_id: PAID })] }),
      run: fakeRun([96], { unuploadedRuns: 3, uploadFailed: true }),
      stateText: JSON.stringify({ format: 'tma-route-nightly-state/1', routes: {}, unuploaded_paid_runs: 2 }),
    });
    expect(r.code).toBe(3);
    expect(r.state.unuploaded_paid_runs).toBe(5);
    expect(r.out).toContain('upload_failed: 3 run(s) not uploaded');
    expect(summaryLine(r.out)).toMatch(/^nightly status=error /);
  });
  it('the API refuses a mark: exit 3, the state is written', async () => {
    const r = await nightly({ run: fakeRun([70]), api: fakeApi({ patchStatus: 409 }) });
    expect(r.code).toBe(3);
    expect(r.out).toContain('needs_check (nightly_drop: absolute NOT YET tonight, cited same) NOT marked: 409 error');
    expect(r.state.routes[ID].last_label).toBe('NOT YET');
  });
  it('a route that is not live is not run; a truncated run list is refused and the state is still written', async () => {
    const f = files(JSON.stringify({ format: 'tma-route-nightly-state/1', routes: {}, unuploaded_paid_runs: 7 }));
    const api = vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/routes') return new Response(JSON.stringify({ routes: [route()] }), { status: 200 });
      return new Response(JSON.stringify({ runs: [], truncated: true }), { status: 200 });
    });
    await expect(nightly({ f, api: api as never })).rejects.toThrow(/runs_truncated/);
    expect(JSON.parse(readFileSync(f.state, 'utf-8')).unuploaded_paid_runs).toBe(7);
  });
  it('--repeat above 10 is refused', async () => {
    const r = await nightly({ extra: ['--repeat', '11'] });
    expect(r.code).toBe(2);
  });
  it('--json prints the routes and the summary', async () => {
    const r = await nightly({ run: fakeRun([70]), extra: ['--json'] });
    const j = JSON.parse(r.out);
    expect(j.routes[0]).toMatchObject({ route_id: ID, outcome: 'dropped', marked: true });
    expect(j.summary).toMatch(/^nightly status=ok /);
  });
});
