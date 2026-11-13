import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { API, TOKEN, captureIo, tempEnv } from '../test/fixtures.js';
import { main } from '../tma.js';
import { makeRouteCommand, type RouteExec } from './route.js';

// Synthetic fixtures in examples/route/: invented ids and hashes only.
const EX = resolve(import.meta.dirname, '../../../examples/route');
const ENV_FILE = 'vps/openclaw-tainan/model-routing/model-routing.env';
const MD_FILE = 'vps/openclaw-tainan/CLAUDE.md';
const APPROVED = JSON.parse(readFileSync(join(EX, 'route.approved.json'), 'utf-8')) as Record<string, any>;
const LIVE = JSON.parse(readFileSync(join(EX, 'route.live.json'), 'utf-8')) as Record<string, any>;
const ID = APPROVED.id as string;
const ORIGINAL_ENV = readFileSync(join(EX, 'infra', ENV_FILE), 'utf-8');
const ORIGINAL_MD = readFileSync(join(EX, 'infra', MD_FILE), 'utf-8');

/** A temp copy of the fixture infra tree, a route file and the targets file. */
function workspace(route: Record<string, unknown> = APPROVED) {
  const dir = mkdtempSync(join(tmpdir(), 'tma-route-'));
  cpSync(join(EX, 'infra'), join(dir, 'infra'), { recursive: true });
  cpSync(join(EX, 'targets.json'), join(dir, 'targets.json'));
  const routeFile = join(dir, 'route.json');
  writeFileSync(routeFile, JSON.stringify(route));
  const repo = join(dir, 'infra');
  return {
    dir,
    repo,
    routeFile,
    setRoute: (r: Record<string, unknown>) => writeFileSync(routeFile, JSON.stringify(r)),
    read: (f: string) => readFileSync(join(repo, f), 'utf-8'),
    write: (f: string, t: string) => writeFileSync(join(repo, f), t),
    args: (sub: string, ...extra: string[]) => [sub, '--route-file', routeFile, '--targets', join(dir, 'targets.json'), '--repo-dir', repo, ...extra],
  };
}

/** A fake exec that records every call; gh pr create prints a PR URL. */
function fakeExec(): RouteExec & { calls: string[] } {
  const calls: string[] = [];
  const f = vi.fn(async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    const stdout = cmd === 'gh' ? 'https://github.com/devfellowship/dfl-infra/pull/4242\n' : '';
    return { code: 0, stdout, stderr: '', timedOut: false };
  }) as unknown as RouteExec & { calls: string[] };
  f.calls = calls;
  return f;
}

async function runRoute(argv: string[], exec = fakeExec(), extra: Record<string, unknown> = {}) {
  const io = captureIo();
  const code = await makeRouteCommand({ exec, ...extra }).main(argv, io);
  return { code, io, exec };
}

const EXPECTED_DRY_DIFF = `--- a/${ENV_FILE}
+++ b/${ENV_FILE}
@@ -6,7 +6,9 @@
 # DFL_ROUTE_HTML_REPORT
 #   deepseek = zai-coding-plan/glm-5.3-flash, 2 attempts, then 1 Sonnet fallback (default)
 #   sonnet   = skip opencode, 1 Sonnet attempt (rollback)
-DFL_ROUTE_HTML_REPORT=deepseek
+# route ${ID} (content/report-html): deepseek -> sonnet; verdict same under the absolute rule, n=5, policy c7-1; approved by example-approver 2026-11-12
+# rollback: DFL_ROUTE_HTML_REPORT=deepseek  (tma route rollback ${ID})
+DFL_ROUTE_HTML_REPORT=sonnet
${' '}
 # DFL_ROUTE_UI_COMPARISON  (skill ui-design-compare: live app vs golden design, Pick C)
 #   deepseek = zai-coding-plan/glm-5.3-flash, 2 attempts, then 1 Sonnet fallback (default)`;

describe('tma route pr --dry-run', () => {
  it('prints the exact diff and the PR text, writes nothing and calls no exec', async () => {
    const w = workspace();
    const { code, io, exec } = await runRoute(w.args('pr', '--dry-run'));
    expect(code).toBe(0);
    expect(exec.calls).toEqual([]);
    expect(w.read(ENV_FILE)).toBe(ORIGINAL_ENV);
    const out = io.outText();
    expect(out.startsWith(`${EXPECTED_DRY_DIFF}\n`)).toBe(true);
    expect(out).toContain('branch: route/content-report-html/7c1e2a90');
    expect(out).toContain('PR title: route(content/report-html): DFL_ROUTE_HTML_REPORT deepseek -> sonnet (route 7c1e2a90)');
    for (const s of [ID, 'content/report-html', 'absolute rule', 'n=5', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'Policy version: c7-1', 'example-approver', 'Rollback: `DFL_ROUTE_HTML_REPORT=deepseek`', 'install -D -m 0644', 'sha256sum', 'README of `vps/openclaw-tainan/model-routing/`']) {
      expect(out).toContain(s);
    }
  });
});

describe('tma route pr: refusals (exit 2, one line, nothing written)', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['state is not approved', { state: 'proposed', approved_by_actor: null, approved_at: null }, /is proposed, not approved/],
    ['state live', { state: 'live' }, /is live, not approved/],
    ['n < 5', { n: 4 }, /n=4; a route needs n >= 5/],
    ['absolute rule, verdict better', { verdict: 'better' }, /does not pass under the absolute rule/],
    ['absolute rule, verdict NOT YET', { verdict: 'NOT YET' }, /does not pass under the absolute rule/],
    ['relative rule, verdict close', { picked_rule: 'relative', verdict: 'close' }, /does not pass under the relative rule/],
    ['use case has no target', { use_case_key: 'content/other' }, /has no target in the flag map/],
    ['route_target differs from the map', { route_target: 'env:DFL_ROUTE_UI_COMPARISON' }, /differs from the map target/],
    ['target_value not allowed', { target_value: 'gpt-x' }, /not an allowed value/],
    ['file moved since approval', { rollback_value: 'sonnet', target_value: 'deepseek' }, /the file moved since approval, re-approve/],
    ['rollback_value null', { rollback_value: null }, /no rollback_value.*re-approve/],
    ['not a valid route row', { note: 'free text' }, /not a valid route row \(tma-route\/1 or tma-route\/2\)/],
  ];
  for (const [name, over, re] of cases) {
    it(name, async () => {
      const w = workspace({ ...APPROVED, ...over });
      const { code, io, exec } = await runRoute(w.args('pr'));
      expect(code).toBe(2);
      expect(io.errText()).toMatch(re);
      expect(io.errText().split('\n')).toHaveLength(1);
      expect(exec.calls).toEqual([]);
      expect(w.read(ENV_FILE)).toBe(ORIGINAL_ENV);
    });
  }

  it('relative rule with verdict better passes', async () => {
    const w = workspace({ ...APPROVED, picked_rule: 'relative', verdict: 'better' });
    expect((await runRoute(w.args('pr', '--dry-run'))).code).toBe(0);
  });

  it('the new value equals the current value', async () => {
    const w = workspace({ ...APPROVED, rollback_value: 'deepseek', target_value: 'deepseek' });
    const { code, io } = await runRoute(w.args('pr'));
    expect(code).toBe(2);
    expect(io.errText()).toMatch(/already holds DFL_ROUTE_HTML_REPORT=deepseek: nothing to change/);
  });

  it('two FLAG= lines in the file', async () => {
    const w = workspace();
    w.write(ENV_FILE, `${ORIGINAL_ENV}DFL_ROUTE_HTML_REPORT=deepseek\n`);
    const { code, io } = await runRoute(w.args('pr'));
    expect(code).toBe(2);
    expect(io.errText()).toMatch(/has 2 lines DFL_ROUTE_HTML_REPORT=/);
  });

  it('a dirty checkout, before any branch or write', async () => {
    const w = workspace();
    const exec = vi.fn(async (_c: string, args: string[]) => ({ code: 0, stdout: args[0] === 'status' ? ' M x\n' : '', stderr: '', timedOut: false }));
    const { code, io } = await runRoute(w.args('pr'), exec as unknown as ReturnType<typeof fakeExec>);
    expect(code).toBe(2);
    expect(io.errText()).toMatch(/uncommitted changes/);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(w.read(ENV_FILE)).toBe(ORIGINAL_ENV);
  });
});

const PLAN_ROUTE = { ...APPROVED, use_case_key: 'plan/write-plan', route_target: 'claude-md:planning', target_value: 'sonnet', rollback_value: 'opus', model_id: 'claude-sonnet-5-5' };
const PLANNING_ROW = '| Planning: plans, analysis, briefs, strategy, ADRs |';

describe('tma route pr: claude-md target', () => {
  it('replaces the model cell of the one matched row and nothing else', async () => {
    const w = workspace(PLAN_ROUTE);
    const { code, io } = await runRoute(w.args('pr'));
    expect(code).toBe(0);
    expect(io.outText()).toBe('https://github.com/devfellowship/dfl-infra/pull/4242');
    expect(w.read(MD_FILE)).toBe(ORIGINAL_MD.replace(`${PLANNING_ROW} **\`opus\`** |`, `${PLANNING_ROW} **\`sonnet\`** |`));
  });

  it('dry run title names the row', async () => {
    const w = workspace(PLAN_ROUTE);
    const { io } = await runRoute(w.args('pr', '--dry-run'));
    expect(io.outText()).toContain('PR title: route(plan/write-plan): planning opus -> sonnet (route 7c1e2a90)');
    expect(io.outText()).toContain(`-${PLANNING_ROW} **\`opus\`** |\n+${PLANNING_ROW} **\`sonnet\`** |`);
  });

  it('refuses 0 matching rows', async () => {
    const w = workspace(PLAN_ROUTE);
    w.write(MD_FILE, ORIGINAL_MD.replace(PLANNING_ROW, '| Plans and ADRs |'));
    const { code, io } = await runRoute(w.args('pr'));
    expect(code).toBe(2);
    expect(io.errText()).toMatch(/has 0 rows that start with/);
  });

  it('refuses 2 matching rows', async () => {
    const w = workspace(PLAN_ROUTE);
    w.write(MD_FILE, `${ORIGINAL_MD}${PLANNING_ROW} **\`opus\`** |\n`);
    const { code, io, exec } = await runRoute(w.args('pr'));
    expect(code).toBe(2);
    expect(io.errText()).toMatch(/has 2 rows that start with/);
    expect(exec.calls).toEqual([]);
  });
});

describe('tma route pr: the non-dry run', () => {
  it('calls git status, checkout, add, commit, push and gh pr create in order, and prints the PR URL', async () => {
    const w = workspace();
    const { code, io, exec } = await runRoute(w.args('pr', '--base', 'main'));
    expect(code).toBe(0);
    const verbs = exec.calls.map((c) => c.split(' ').slice(0, 3).join(' '));
    expect(verbs).toEqual(['git status --porcelain', 'git checkout -b', 'git add --', 'git commit -m', 'git push -u', 'gh pr create']);
    expect(exec.calls[1]).toBe('git checkout -b route/content-report-html/7c1e2a90');
    expect(exec.calls[4]).toBe('git push -u origin route/content-report-html/7c1e2a90');
    expect(exec.calls[5]).toContain('gh pr create --base main --head route/content-report-html/7c1e2a90 --title route(content/report-html): DFL_ROUTE_HTML_REPORT deepseek -> sonnet (route 7c1e2a90) --body ');
    expect(io.outText()).toBe('https://github.com/devfellowship/dfl-infra/pull/4242');
    expect(io.errText()).toContain(`tma route mark --route ${ID} --state live --pr https://github.com/devfellowship/dfl-infra/pull/4242`);
    expect(w.read(ENV_FILE)).toContain('DFL_ROUTE_HTML_REPORT=sonnet\n');
  });

  it('a failing git step stops the flow with exit 1', async () => {
    const w = workspace();
    const exec = vi.fn(async (_c: string, args: string[]) => ({ code: args[0] === 'push' ? 128 : 0, stdout: '', stderr: args[0] === 'push' ? 'remote: denied' : '', timedOut: false }));
    const io = captureIo();
    await expect(makeRouteCommand({ exec: exec as unknown as RouteExec }).main(w.args('pr'), io)).rejects.toThrow(/git push -u failed \(exit 128\): remote: denied/);
    expect(exec.mock.calls.map((c) => c[1][0])).toEqual(['status', 'checkout', 'add', 'commit', 'push']);
  });
});

describe('tma route: a second pr and the rollback', () => {
  it('a second pr replaces the earlier route block instead of stacking it', async () => {
    const w = workspace();
    expect((await runRoute(w.args('pr'))).code).toBe(0);
    const ID2 = '9d8e7f60-1111-4222-8333-444455556666';
    w.setRoute({ ...APPROVED, id: ID2, target_value: 'deepseek', rollback_value: 'sonnet', verdict: 'close', n: 6 });
    expect((await runRoute(w.args('pr'))).code).toBe(0);
    const text = w.read(ENV_FILE);
    expect(text.match(/^# route /gm)).toHaveLength(1);
    expect(text.match(/^# rollback: /gm)).toHaveLength(1);
    expect(text).toContain(`# route ${ID2} (content/report-html): sonnet -> deepseek; verdict close under the absolute rule, n=6`);
    expect(text).toContain(`# rollback: DFL_ROUTE_HTML_REPORT=sonnet  (tma route rollback ${ID2})`);
    expect(text).not.toContain(ID);
    // Every other comment stays.
    const others = (t: string) => t.split('\n').filter((l) => !/^# route |^# rollback: |^DFL_ROUTE_HTML_REPORT=/.test(l));
    expect(others(text)).toEqual(others(ORIGINAL_ENV));
  });

  it('pr then rollback restores the old line byte for byte; only the rolled-back comment line remains', async () => {
    const w = workspace();
    expect((await runRoute(w.args('pr'))).code).toBe(0);
    w.setRoute(LIVE);
    const { code, io, exec } = await runRoute(w.args('rollback'));
    expect(code).toBe(0);
    const text = w.read(ENV_FILE);
    const rolled = `# route ${ID} rolled back: sonnet -> deepseek`;
    expect(text).toBe(ORIGINAL_ENV.replace('DFL_ROUTE_HTML_REPORT=deepseek\n', `${rolled}\nDFL_ROUTE_HTML_REPORT=deepseek\n`));
    expect(text.split('\n').filter((l) => l !== rolled).join('\n')).toBe(ORIGINAL_ENV);
    expect(exec.calls[1]).toBe('git checkout -b route/content-report-html/7c1e2a90-rollback');
    expect(exec.calls[5]).toContain('--title route(content/report-html): rollback DFL_ROUTE_HTML_REPORT sonnet -> deepseek (route 7c1e2a90)');
    expect(io.errText()).toContain('--state rolled_back');
  });

  it('rollback dry run of a claude-md route restores the cell', async () => {
    const w = workspace(PLAN_ROUTE);
    expect((await runRoute(w.args('pr'))).code).toBe(0);
    w.setRoute({ ...PLAN_ROUTE, state: 'needs_check' });
    expect((await runRoute(w.args('rollback'))).code).toBe(0);
    expect(w.read(MD_FILE)).toBe(ORIGINAL_MD);
  });

  it('rollback refuses: not live, null rollback_value, file not at the route value', async () => {
    const w = workspace(LIVE);
    w.setRoute(APPROVED);
    let r = await runRoute(w.args('rollback'));
    expect(r.code).toBe(2);
    expect(r.io.errText()).toMatch(/is approved: only a live or needs_check route is rolled back/);

    w.setRoute({ ...LIVE, rollback_value: null });
    r = await runRoute(w.args('rollback'));
    expect(r.code).toBe(2);
    expect(r.io.errText()).toMatch(/no rollback_value: there is no old value to restore/);

    w.setRoute(LIVE); // the file still holds deepseek = the rollback value
    r = await runRoute(w.args('rollback'));
    expect(r.code).toBe(2);
    expect(r.io.errText()).toMatch(/nothing to roll back/);
    expect(r.exec.calls).toEqual([]);
  });
});

function loggedIn() {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

describe('tma route --route <id> and mark (mocked API)', () => {
  it('pr --route reads GET /routes/:id with the session', async () => {
    const w = workspace();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(APPROVED), { status: 200 }));
    const argv = ['pr', '--route', ID, '--targets', join(w.dir, 'targets.json'), '--repo-dir', w.repo, '--dry-run'];
    const { code, io } = await runRoute(argv, fakeExec(), { env: loggedIn(), fetchImpl });
    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/routes/${ID}`);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(io.outText()).toContain(EXPECTED_DRY_DIFF);
  });

  it('accepts a tma-route/2 row from the API through the same path as a v1 row (pr and rollback)', async () => {
    const v2 = (r: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
      ...r, format: 'tma-route/2', live_at: null, rollback_pr_url: null, rolled_back_at: null, ...over,
    });
    const w = workspace();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(v2(APPROVED)), { status: 200 }));
    const argv = ['pr', '--route', ID, '--targets', join(w.dir, 'targets.json'), '--repo-dir', w.repo, '--dry-run'];
    const { code, io } = await runRoute(argv, fakeExec(), { env: loggedIn(), fetchImpl });
    expect(io.errText()).not.toMatch(/not a valid/);
    expect(code).toBe(0);
    expect(io.outText()).toContain(EXPECTED_DRY_DIFF);
    // A v2 file runs through --route-file too; a live v2 row rolls back like the v1 example.
    expect((await runRoute(w.args('pr'))).code).toBe(0);
    w.setRoute(v2(LIVE, { live_at: '2026-11-13T10:00:00Z' }));
    expect((await runRoute(w.args('rollback', '--dry-run'))).code).toBe(0);
    // A v2 live row without live_at is refused as an invalid row.
    w.setRoute(v2(LIVE));
    const bad = await runRoute(w.args('rollback', '--dry-run'));
    expect(bad.code).toBe(2);
    expect(bad.io.errText()).toMatch(/not a valid route row.*\/live_at is null/);
  });

  it('pr --route says clearly that GET /routes/:id is not there yet on 404', async () => {
    const w = workspace();
    const fetchImpl = vi.fn(async () => new Response('{"error":"not found"}', { status: 404 }));
    const argv = ['pr', '--route', ID, '--targets', join(w.dir, 'targets.json'), '--repo-dir', w.repo, '--dry-run'];
    await expect(runRoute(argv, fakeExec(), { env: loggedIn(), fetchImpl })).rejects.toThrow(/ships with task T2/);
  });

  it('mark sends PATCH /routes/:id/state with {state, pr_url}', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: ID, state: 'live' }), { status: 200 }));
    const pr = 'https://github.com/devfellowship/dfl-infra/pull/4242';
    const { code, io } = await runRoute(['mark', '--route', ID, '--state', 'live', '--pr', pr], fakeExec(), { env: loggedIn(), fetchImpl });
    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/routes/${ID}/state`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ state: 'live', pr_url: pr });
    expect(io.outText()).toBe(`route ${ID} -> live (${pr})`);
  });

  it('mark prints a clear line on 404 (T2 not shipped) and exits 1', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    const { code, io } = await runRoute(['mark', '--route', ID, '--state', 'rolled_back', '--pr', 'https://github.com/devfellowship/dfl-infra/pull/1'], fakeExec(), { env: loggedIn(), fetchImpl });
    expect(code).toBe(1);
    expect(io.errText()).toMatch(/404 .*does not have this endpoint yet \(task T2/);
  });

  it('mark refuses a bad state or PR URL before any call', async () => {
    const fetchImpl = vi.fn();
    await expect(runRoute(['mark', '--route', ID, '--state', 'approved', '--pr', 'https://github.com/a/b/pull/1'], fakeExec(), { env: loggedIn(), fetchImpl })).rejects.toThrow(/live or rolled_back/);
    await expect(runRoute(['mark', '--route', ID, '--state', 'live', '--pr', 'http://x'], fakeExec(), { env: loggedIn(), fetchImpl })).rejects.toThrow(/pull request URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('tma route in the CLI', () => {
  it('is listed in tma help and has --help', async () => {
    const io = captureIo();
    await main(['help'], io);
    expect(io.outText()).toMatch(/route\s+Apply an approved model route by a PR/);
    const h = captureIo();
    expect(await main(['route', '--help'], h)).toBe(0);
    expect(h.outText()).toContain('usage: tma route pr');
  });
});
