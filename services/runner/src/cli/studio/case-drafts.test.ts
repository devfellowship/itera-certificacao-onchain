// MT-05 "Build N cases" (plan 20261118-melhorias-tma): /v1/case-drafts of `tma studio serve`. Two synthetic trees, as
// in server.fixture.test.ts: one stands in for the REAL sources, one is the fixture tree. The bar:
//   - a fixture principal writes drafts ONLY into the fixture store, from the fixture traces; a real principal ONLY
//     into the real store (mutation: swap the two cases of storeFor() and the store tests fail);
//   - each draft is a valid tma-case/1 manifest at cases/<type>/<subtype>/<case_key>/case.json, with the pin record;
//   - a run without a pin record is skipped with its reason; a second build of the same run is case_exists;
//   - the real store (a clone of the eval repo) makes one branch and one commit and runs the publish command.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseErrors } from '../eval/case.js';
import { buildCaseDrafts, CASE_DRAFT_WRITER, DirCaseStore, draftCaseKey, GitCaseStore, parseBuildBody, CaseDraftRefused } from './case-drafts.js';
import { traceId } from './content.js';
import { buildFixture, FIXTURE_VARIANT, type FixtureVariant } from './fixture.js';
import { ALLOWED, fakeApi, webToken } from './fixture.test-helpers.js';
import { startStudioServer, storeFor, type StudioServerOptions } from './server.js';

const FIXTURE_P = 'dfl:00000000-0000-4000-8000-0000000000f1';
const REAL: FixtureVariant = {
  sidA: 'eeeeeeee-0000-4000-8000-00000000000e',
  sidB: 'ffffffff-0000-4000-8000-00000000000f',
  sidOutside: '99999999-0000-4000-8000-000000000009',
  subAgent: 'a0real0sub',
  identifier: 'REAL-00001',
  taskId: '22222222-0000-4000-8000-000000000002',
  label: 'Realtree',
};
const FX = FIXTURE_VARIANT;
const real = buildFixture(undefined, REAL);
const fix = buildFixture();
const tmp = mkdtempSync(join(tmpdir(), 'tma-case-drafts-'));
const fixtureStoreRoot = join(tmp, 'fixture-cases');
const realStoreRoot = join(tmp, 'real-cases');

const FX_SUB = traceId(FX.sidA, FX.subAgent);
const FX_B = traceId(FX.sidB, null);
const FX_A = traceId(FX.sidA, null);
const REAL_B = traceId(REAL.sidB, null);

let server: Server;
let base: string;
const opts = (): StudioServerOptions => ({
  sources: real,
  fixtureSources: fix,
  auth: { introspect: fakeApi(), allowPrincipals: new Set([ALLOWED]), fixturePrincipals: new Set([FIXTURE_P]) },
  allowOrigins: new Set(['https://studio.fixture.test']),
  caseStores: { fixture: new DirCaseStore(fixtureStoreRoot), real: new DirCaseStore(realStoreRoot) },
});
beforeAll(async () => {
  server = await startStudioServer(0, opts());
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  for (const d of [real.root, fix.root, tmp]) rmSync(d, { recursive: true, force: true });
});

const as = (sub: string) => ({ authorization: `Bearer ${webToken(sub)}` });
async function call(method: string, path: string, sub: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = sub ? as(sub) : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
}

describe('parseBuildBody', () => {
  it('takes 1 to 20 distinct trace ids and one L1 pair', () => {
    expect(parseBuildBody(JSON.stringify({ trace_ids: ['0123456789ab'], use_case: 'fix/red-ci' }))).toEqual({ trace_ids: ['0123456789ab'], use_case: 'fix/red-ci' });
    const bad = [
      'not json',
      '[]',
      JSON.stringify({ trace_ids: [], use_case: 'fix/red-ci' }),
      JSON.stringify({ trace_ids: Array.from({ length: 21 }, (_, i) => i.toString(16).padStart(12, '0')), use_case: 'fix/red-ci' }),
      JSON.stringify({ trace_ids: ['0123456789ab', '0123456789ab'], use_case: 'fix/red-ci' }),
      JSON.stringify({ trace_ids: ['not-a-trace'], use_case: 'fix/red-ci' }),
      JSON.stringify({ trace_ids: ['0123456789ab'], use_case: 'fix' }),
      JSON.stringify({ trace_ids: ['0123456789ab'], use_case: 'fix/red-ci', extra: 1 }),
    ];
    for (const b of bad) expect(() => parseBuildBody(b), b).toThrow(CaseDraftRefused);
  });

  it('keys a case by the trace-pin review_batch rule', () => {
    expect(draftCaseKey('4DA84C52-97a3', 's', 'a423a4c8085c7a1e2')).toBe('trace-4da84c52-a423a4c8');
    expect(draftCaseKey('4da84c52-97a3', '03de6bc3-c91b', null)).toBe('trace-4da84c52-03de6bc3');
  });
});

describe('/v1/case-drafts', () => {
  it('needs a login and a store for the login kind', async () => {
    expect((await call('GET', '/v1/case-drafts', null)).status).toBe(401);
    expect((await call('POST', '/v1/case-drafts', null, { trace_ids: [FX_B], use_case: 'plan/write-plan' })).status).toBe(401);
    const s = await startStudioServer(0, { ...opts(), caseStores: {} });
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/case-drafts`;
    const r = await fetch(url, { headers: as(FIXTURE_P) });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'case_store_not_configured' });
    await new Promise((r2) => s.close(r2));
  });

  it('a fixture build writes valid tma-case/1 drafts of the fixture traces into the fixture store only', async () => {
    const r = await call('POST', '/v1/case-drafts', FIXTURE_P, { trace_ids: [FX_SUB, FX_B, FX_A], use_case: 'build/feature' });
    expect(r.status).toBe(200);
    expect(r.body.store).toBe('fixture');
    expect(r.body.pr_url).toBeNull();
    expect(r.body.created.map((c: any) => c.case_key).sort()).toEqual([`trace-11111111-a0fixtur`, `trace-11111111-bbbbbbbb`]);
    expect(r.body.skipped).toEqual([{ trace_id: FX_A, reason: 'no_pin_record' }]);
    for (const c of r.body.created) {
      expect(c.path).toBe(`cases/build/feature/${c.case_key}/case.json`);
      const m = JSON.parse(readFileSync(join(fixtureStoreRoot, c.path), 'utf8'));
      expect(caseErrors(m)).toEqual([]);
      expect(m).toMatchObject({ schema: 'tma-case/1', use_case: 'build/feature', source: 'trace', split: 'none', task_ref: { kind: 'dfl-task', id: FX.taskId } });
      expect(m.expected.written_by).toBe(CASE_DRAFT_WRITER);
      expect(m.pin.record.pin_sha256).toBe(m.pin.pin_sha256);
      expect(m.graders.map((g: any) => `${g.id}@${g.version}`)).toEqual(['async-wait-lifecycle@0.1.0', 'external-block-handling@0.1.0']);
      expect(JSON.stringify(m)).not.toContain('Realtree');
    }
    // sidB is a replay candidate with a complete pin: a replay case. The sub-agent pin is partial: trace_review.
    const byKey = Object.fromEntries(r.body.created.map((c: any) => [c.case_key, JSON.parse(readFileSync(join(fixtureStoreRoot, c.path), 'utf8'))]));
    expect(byKey['trace-11111111-bbbbbbbb'].mode).toBe('replay');
    expect(byKey['trace-11111111-a0fixtur'].mode).toBe('trace_review');
    // Nothing went to the real store.
    expect(existsSync(join(realStoreRoot, 'cases'))).toBe(false);
  });

  it('reads the drafts back, refuses a second build of the same run, and removes one draft', async () => {
    const list = await call('GET', '/v1/case-drafts', FIXTURE_P);
    expect(list.status).toBe(200);
    expect(list.body.drafts.map((d: any) => d.case_key).sort()).toEqual(['trace-11111111-a0fixtur', 'trace-11111111-bbbbbbbb']);
    const again = await call('POST', '/v1/case-drafts', FIXTURE_P, { trace_ids: [FX_B], use_case: 'build/feature' });
    expect(again.body).toMatchObject({ created: [], skipped: [{ trace_id: FX_B, reason: 'case_exists' }] });
    expect((await call('DELETE', '/v1/case-drafts/trace-11111111-bbbbbbbb', FIXTURE_P)).body).toEqual({ removed: 'trace-11111111-bbbbbbbb' });
    expect((await call('DELETE', '/v1/case-drafts/trace-11111111-bbbbbbbb', FIXTURE_P)).status).toBe(404);
    expect((await call('GET', '/v1/case-drafts', FIXTURE_P)).body.drafts.map((d: any) => d.case_key)).toEqual(['trace-11111111-a0fixtur']);
  });

  it('a fixture principal cannot build from a real trace id, and a real principal never sees a fixture draft', async () => {
    const r = await call('POST', '/v1/case-drafts', FIXTURE_P, { trace_ids: [REAL_B], use_case: 'build/feature' });
    expect(r.body).toMatchObject({ created: [], skipped: [{ trace_id: REAL_B, reason: 'trace_not_found' }] });
    const mine = await call('GET', '/v1/case-drafts', ALLOWED);
    expect(mine.body.drafts).toEqual([]);
    const built = await call('POST', '/v1/case-drafts', ALLOWED, { trace_ids: [REAL_B], use_case: 'plan/write-plan' });
    expect(built.body.created.map((c: any) => c.case_key)).toEqual(['trace-22222222-ffffffff']);
    expect(existsSync(join(realStoreRoot, 'cases/plan/write-plan/trace-22222222-ffffffff/case.json'))).toBe(true);
    expect(existsSync(join(fixtureStoreRoot, 'cases/plan'))).toBe(false);
  });

  it('storeFor picks by login kind and never falls back to the real store', () => {
    const f = new DirCaseStore(join(tmp, 'sf-f'));
    const rl = new DirCaseStore(join(tmp, 'sf-r'));
    expect(storeFor({ kind: 'fixture' }, { caseStores: { fixture: f, real: rl } })).toBe(f);
    expect(storeFor({ kind: 'real' }, { caseStores: { fixture: f, real: rl } })).toBe(rl);
    expect(storeFor({ kind: 'fixture' }, { caseStores: { real: rl } })).toBeNull();
  });

  it('checks the method, the media type and the body size', async () => {
    expect((await call('PUT', '/v1/case-drafts', FIXTURE_P, {})).status).toBe(405);
    expect((await call('DELETE', '/v1/case-drafts', FIXTURE_P)).status).toBe(405);
    expect((await call('POST', '/v1/case-drafts/trace-11111111-a0fixtur', FIXTURE_P, {})).status).toBe(405);
    const r415 = await fetch(`${base}/v1/case-drafts`, { method: 'POST', headers: { ...as(FIXTURE_P), 'content-type': 'text/plain' }, body: '{}' });
    expect(r415.status).toBe(415);
    const r413 = await call('POST', '/v1/case-drafts', FIXTURE_P, JSON.stringify({ trace_ids: ['x'.repeat(20000)] }));
    expect(r413.status).toBe(413);
    expect((await call('POST', '/v1/case-drafts', FIXTURE_P, { trace_ids: ['nothex'], use_case: 'fix/red-ci' })).body).toMatchObject({ error: 'bad_trace_ids' });
  });

  it('answers a CORS preflight with POST and DELETE for an allowed origin', async () => {
    const r = await fetch(`${base}/v1/case-drafts`, { method: 'OPTIONS', headers: { origin: 'https://studio.fixture.test' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE');
    expect(r.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
  });
});

describe('GitCaseStore (the eval repo clone)', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  it('makes one branch with one commit of the drafts, runs the publish command, and goes back to origin/main', async () => {
    const remote = join(tmp, 'evals.git');
    const seed = join(tmp, 'seed');
    const clone = join(tmp, 'clone');
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', seed]);
    writeFileSync(join(seed, 'README.md'), 'eval repo\n');
    git(seed, 'add', '.');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed');
    git(seed, 'push', '--quiet', remote, 'main');
    execFileSync('git', ['clone', '--quiet', remote, clone]);
    const pushed = join(tmp, 'published.txt');
    const publish = join(tmp, 'publish.sh');
    writeFileSync(publish, `#!/bin/sh\nset -e\ngit -C "$1" push --quiet origin "$2"\necho "$2|$3" > ${pushed}\necho https://github.com/devfellowship/dfl-evals/pull/42\n`);
    chmodSync(publish, 0o755);
    const store = new GitCaseStore({ repo: clone, publishCmd: publish, now: () => new Date('2026-11-19T10:11:12Z') });
    const res = await buildCaseDrafts(fix, store, { trace_ids: [FX_SUB, FX_A], use_case: 'fix/red-ci' }, undefined, new Date('2026-11-19T10:11:12Z'));
    expect(res).toMatchObject({ store: 'evals', pr_url: 'https://github.com/devfellowship/dfl-evals/pull/42', branch: 'studio/build-cases-20261119t101112' });
    expect(res.created.map((c) => c.case_key)).toEqual(['trace-11111111-a0fixtur']);
    expect(readFileSync(pushed, 'utf8').trim()).toBe('studio/build-cases-20261119t101112|cases: 1 draft from studio traces (fix/red-ci)');
    // The branch on the remote holds the draft; main does not; the clone is back on a detached origin/main.
    const files = git(remote, 'ls-tree', '-r', '--name-only', 'studio/build-cases-20261119t101112');
    expect(files).toContain('cases/fix/red-ci/trace-11111111-a0fixtur/case.json');
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('cases/');
    expect(git(clone, 'status', '--porcelain')).toBe('');
    expect(git(clone, 'rev-parse', 'HEAD').trim()).toBe(git(clone, 'rev-parse', 'origin/main').trim());
    // A case on origin/main is case_exists.
    git(seed, 'pull', '--quiet', remote, 'studio/build-cases-20261119t101112');
    git(seed, 'push', '--quiet', remote, 'HEAD:main');
    const again = await buildCaseDrafts(fix, store, { trace_ids: [FX_SUB], use_case: 'fix/red-ci' });
    expect(again).toMatchObject({ created: [], skipped: [{ trace_id: FX_SUB, reason: 'case_exists' }], pr_url: null });
    await expect(store.remove()).rejects.toMatchObject({ code: 'close_the_pr' });
  });

  it('a publish command that prints no PR URL fails the build and leaves the clone clean', async () => {
    const remote = join(tmp, 'evals2.git');
    const clone = join(tmp, 'clone2');
    const seed = join(tmp, 'seed2');
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', seed]);
    writeFileSync(join(seed, 'README.md'), 'x\n');
    git(seed, 'add', '.');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed');
    git(seed, 'push', '--quiet', remote, 'main');
    execFileSync('git', ['clone', '--quiet', remote, clone]);
    const publish = join(tmp, 'publish-bad.sh');
    writeFileSync(publish, '#!/bin/sh\necho no url\n');
    chmodSync(publish, 0o755);
    const store = new GitCaseStore({ repo: clone, publishCmd: publish });
    await expect(buildCaseDrafts(fix, store, { trace_ids: [FX_SUB], use_case: 'fix/red-ci' })).rejects.toMatchObject({ code: 'evals_publish_failed' });
    expect(git(clone, 'status', '--porcelain')).toBe('');
    expect(git(clone, 'branch', '--list', 'studio/*').trim()).toBe('');
  });
});
