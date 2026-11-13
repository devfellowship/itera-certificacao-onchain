// `tma route recheck` (plan 20261112-tma-c8-routing-from-evals, T5 exit). Synthetic fixtures in examples/route/:
// invented ids and digests only.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validateRouteObservation } from '@itera/contracts';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { API, TOKEN, captureIo, tempEnv } from '../test/fixtures.js';
import { validateRecheckState } from '../route/recheck.js';
import { makeRouteCommand, type RouteExec } from './route.js';

const EX = resolve(import.meta.dirname, '../../../examples/route');
const LIVE = JSON.parse(readFileSync(join(EX, 'route.live.json'), 'utf-8')) as Record<string, any>;
const OBS = JSON.parse(readFileSync(join(EX, 'observation.json'), 'utf-8')) as Record<string, any>;
const STATE_TEXT = readFileSync(join(EX, 'recheck-state.json'), 'utf-8');
const ID = LIVE.id as string;
const PAIR = LIVE.use_case_key as string;

/** The ONE fixture live route: the example live route as the API answers it (tma-route/2), with its agent. */
const ROUTE = {
  ...LIVE,
  format: 'tma-route/2',
  live_at: '2026-11-13T10:00:00Z',
  rollback_pr_url: null,
  rolled_back_at: null,
  harness: 'claude-code',
  harness_repo_sha: '1'.repeat(40),
  rules_sha256: '2'.repeat(64),
  skills_sha256: ['3'.repeat(64)],
};

function loggedIn(): NodeJS.ProcessEnv {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

/** A fake API: GET /routes?state=live answers the fixture route; PATCH answers `patchStatus`. */
function fakeApi(patchStatus = 200, patchBody: Record<string, unknown> = { id: ID, state: 'needs_check' }) {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'GET') return new Response(JSON.stringify({ routes: [ROUTE] }), { status: 200 });
    return new Response(JSON.stringify(patchBody), { status: patchStatus });
  });
}

function neverExec(): RouteExec {
  return vi.fn(async () => {
    throw new Error('recheck must not run git or gh');
  }) as unknown as RouteExec;
}

function workspace(observation: Record<string, unknown> = OBS, stateText: string | null = STATE_TEXT) {
  const dir = mkdtempSync(join(tmpdir(), 'tma-recheck-'));
  const obsFile = join(dir, 'observation.json');
  const stateFile = join(dir, 'state.json');
  writeFileSync(obsFile, JSON.stringify(observation));
  if (stateText !== null) writeFileSync(stateFile, stateText);
  return { dir, obsFile, stateFile, args: (...extra: string[]) => ['recheck', '--observed', obsFile, '--state', stateFile, ...extra] };
}

async function run(argv: string[], fetchImpl = fakeApi(), exec = neverExec()) {
  const io = captureIo();
  const code = await makeRouteCommand({ exec, env: loggedIn(), fetchImpl: fetchImpl as never }).main(argv, io);
  return { code, io, fetchImpl, exec };
}

const patches = (f: ReturnType<typeof fakeApi>) =>
  f.mock.calls.filter(([, init]) => init.method === 'PATCH').map(([url, init]) => ({ url, body: JSON.parse(String(init.body)) }));

describe('the examples', () => {
  it('the observation and the state examples are valid and give no trigger', async () => {
    expect(validateRouteObservation(OBS).ok).toBe(true);
    expect(validateRecheckState(JSON.parse(STATE_TEXT)).ok).toBe(true);
    const w = workspace();
    const { code, io, fetchImpl } = await run(w.args());
    expect(code).toBe(0);
    expect(patches(fetchImpl)).toEqual([]);
    expect(io.outText()).toBe(`route ${ID} ${PAIR}: ok`);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${API}/routes?state=live`);
  });
});

describe('tma route recheck: the T5 exit (each of the four triggers marks the fixture route)', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['model_or_price', { models: { digest: 'e'.repeat(64) } }, /model_or_price: models d{12} -> e{12}/],
    ['task_mix', { mix: { window_days: 14, total: 90, shares: { [PAIR]: 41, 'plan/write-plan': 12.5 } } }, /task_mix: share 30 -> 41 \(14d, n=90\)/],
    ['grader_version', { graders: { [PAIR]: { 'html-structure': '1.3.0' } } }, /grader_version: html-structure 1\.2\.0 -> 1\.3\.0/],
    ['agent_change', { agents: { 'claude-code': { ...OBS.agents['claude-code'], rules_sha256: '9'.repeat(64) } } }, /agent_change: claude-code rules_sha256 2{12} -> 9{12}/],
  ];
  for (const [kind, over, re] of cases) {
    it(kind, async () => {
      const w = workspace({ ...OBS, ...over });
      const { code, io, fetchImpl, exec } = await run(w.args());
      expect(code).toBe(0);
      expect(patches(fetchImpl)).toEqual([{ url: `${API}/routes/${ID}/state`, body: { state: 'needs_check' } }]);
      const lines = io.outText().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^route ${ID} ${PAIR}: needs_check \\(${kind}: `));
      expect(lines[0]).toMatch(re);
      expect(lines[0]).toMatch(/\) marked$/);
      expect(exec).not.toHaveBeenCalled();
      // The baseline stays (the marked route leaves live and drops out next run).
      expect(JSON.parse(readFileSync(w.stateFile, 'utf-8'))).toEqual(JSON.parse(STATE_TEXT));
    });
  }
});

describe('tma route recheck: dry run, refusals, bad input', () => {
  it('--dry-run sends no PATCH, says would mark, and still writes the state', async () => {
    // No state file: first sight, so only the agent trigger can fire.
    const w = workspace({ ...OBS, agents: { 'claude-code': { ...OBS.agents['claude-code'], harness_repo_sha: '9'.repeat(40) } } }, null);
    const { code, io, fetchImpl } = await run(w.args('--dry-run'));
    expect(code).toBe(0);
    expect(patches(fetchImpl)).toEqual([]);
    expect(io.outText()).toMatch(/needs_check \(agent_change: claude-code harness_repo_sha 1{12} -> 9{12}\) would mark \(dry run\) \[first sight/);
    const state = JSON.parse(readFileSync(w.stateFile, 'utf-8'));
    expect(validateRecheckState(state).ok).toBe(true);
    expect(Object.keys(state.routes)).toEqual([ID]);
    expect(readdirSync(w.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a 403 not_an_apply_actor: exit 3, the line says NOT marked, the state is written', async () => {
    const w = workspace({ ...OBS, models: { digest: 'e'.repeat(64) } });
    const api = fakeApi(403, { error: 'not_an_apply_actor', message: 'x' });
    const { code, io } = await run(w.args(), api);
    expect(code).toBe(3);
    expect(io.outText()).toBe(`route ${ID} ${PAIR}: needs_check (model_or_price: models ${'d'.repeat(12)} -> ${'e'.repeat(12)}) NOT marked: 403 not_an_apply_actor`);
    expect(patches(api)).toHaveLength(1);
    expect(existsSync(w.stateFile)).toBe(true);
  });

  it('a 409 is reported per route, exit 3; --json prints marks and refused', async () => {
    const w = workspace({ ...OBS, models: { digest: 'e'.repeat(64) } });
    const { code, io } = await run(w.args('--json'), fakeApi(409, { error: 'invalid_transition' }));
    expect(code).toBe(3);
    const out = JSON.parse(io.outText());
    expect(out.marks).toEqual([]);
    expect(out.refused).toEqual([{ route_id: ID, use_case_key: PAIR, status: 409, error: 'invalid_transition' }]);
  });

  it('--json on a marked route', async () => {
    const w = workspace({ ...OBS, models: { digest: 'e'.repeat(64) } });
    const { code, io } = await run(w.args('--json'));
    expect(code).toBe(0);
    const out = JSON.parse(io.outText());
    expect(out.marks).toEqual([{ route_id: ID, use_case_key: PAIR, triggers: [{ kind: 'model_or_price', detail: `models ${'d'.repeat(12)} -> ${'e'.repeat(12)}` }] }]);
    expect(out.refused).toEqual([]);
  });

  it('an invalid observation: exit 2, no API call, the state file is unchanged', async () => {
    const w = workspace({ ...OBS, note: 'free text' });
    const { code, io, fetchImpl } = await run(w.args());
    expect(code).toBe(2);
    expect(io.errText()).toMatch(/not a valid tma-route-observation\/1 file/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(w.stateFile, 'utf-8')).toBe(STATE_TEXT);
  });

  it('an invalid state file: exit 2, and it is never overwritten', async () => {
    const w = workspace(OBS, '{"format":"tma-route-recheck-state/1","routes":{"x":1}}');
    const { code, io, fetchImpl } = await run(w.args());
    expect(code).toBe(2);
    expect(io.errText()).toMatch(/not a tma-route-recheck-state\/1 file.*left as it is/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(w.stateFile, 'utf-8')).toBe('{"format":"tma-route-recheck-state/1","routes":{"x":1}}');
    const notJson = workspace(OBS, '{');
    expect((await run(notJson.args())).code).toBe(2);
    expect(readFileSync(notJson.stateFile, 'utf-8')).toBe('{');
  });

  it('usage errors exit 2', async () => {
    expect((await run(['recheck', '--observed', 'x.json'])).code).toBe(2);
    expect((await run(['recheck', '--bogus'])).code).toBe(2);
  });

  it('a live row that fails validateRoute stops the run (exit 1), no PATCH, no state write', async () => {
    const w = workspace({ ...OBS, models: { digest: 'e'.repeat(64) } }, null);
    const api = vi.fn(async () => new Response(JSON.stringify({ routes: [{ ...ROUTE, live_at: null }] }), { status: 200 }));
    const { code, io } = await run(w.args(), api as never);
    expect(code).toBe(1);
    expect(io.errText()).toMatch(/tma route recheck: route .* is not a valid route row/);
    expect(existsSync(w.stateFile)).toBe(false);
  });

  it('never calls the exec dependency (no git, no gh), in any mode', async () => {
    const exec = neverExec();
    for (const extra of [[], ['--dry-run'], ['--json']]) {
      const w = workspace({ ...OBS, models: { digest: 'e'.repeat(64) } });
      await run(w.args(...extra), fakeApi(), exec);
    }
    const bad = workspace({ ...OBS, models: { digest: 'e'.repeat(64) } });
    await run(bad.args(), fakeApi(403, { error: 'not_an_apply_actor' }), exec);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('tma route recheck: the help', () => {
  it('is in the route usage', async () => {
    const io = captureIo();
    await expect(makeRouteCommand().main(['nope'], io)).rejects.toThrow(/tma route recheck --observed/);
  });
});

