// Fixture principals of `tma studio serve` (task S2S3-FIXTURE-PRINCIPAL). Two synthetic trees: one stands in for
// the REAL sources (ids eeee/ffff/9999, label "Realtree"), one is the fixture tree of `tma studio fixture`.
// The bar: a fixture principal never reaches a real source by any route (list, search, detail, steps, file, dry
// run), and a real principal never sees a fixture row. Mutation: route a fixture principal to the real sources in
// sourcesFor() and the route tests below fail.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixture, FIXTURE_MARKER, FIXTURE_VARIANT, fixtureSourcesAt, type FixtureVariant } from './fixture.js';
import { ALLOWED, fakeApi, OTHER, webToken } from './fixture.test-helpers.js';
import { route, sourcesFor, startStudioServer, type StudioServerOptions } from './server.js';

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
const realMarkers = [REAL.sidA, REAL.sidB, REAL.sidOutside, REAL.subAgent, REAL.identifier, REAL.taskId, 'Realtree', 'realtree', real.root];
const fixtureMarkers = [FX.sidA, FX.sidB, FX.sidOutside, FX.subAgent, FX.identifier, 'Fixture', 'fixture-', fix.root];

/** No real id, label or path anywhere in the answer. */
function expectNoReal(body: unknown) {
  const text = JSON.stringify(body);
  for (const m of realMarkers) expect(text, `real marker ${m} in a fixture answer`).not.toContain(m);
}
function expectNoFixture(body: unknown) {
  const text = JSON.stringify(body);
  for (const m of fixtureMarkers) expect(text, `fixture marker ${m} in a real answer`).not.toContain(m);
}

const opts = (): StudioServerOptions => ({
  sources: real,
  fixtureSources: fix,
  auth: { introspect: fakeApi(), allowPrincipals: new Set([ALLOWED]), fixturePrincipals: new Set([FIXTURE_P]) },
  allowOrigins: new Set(),
  dryRun: { graderRoot: real.root },
});

let server: Server;
let base: string;
beforeAll(async () => {
  server = await startStudioServer(0, opts());
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(real.root, { recursive: true, force: true });
  rmSync(fix.root, { recursive: true, force: true });
});

const as = (sub: string) => ({ authorization: `Bearer ${webToken(sub)}` });
async function get(path: string, sub: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: as(sub) });
  return { status: r.status, body: await r.json() };
}

describe('fixture principal: never a real source, on every route', () => {
  it('S13 /v1/pins: the same pin sha resolves in the fixture tree for the fixture principal and in the real tree for the real one', async () => {
    for (const sha of ['f'.repeat(64), 'e'.repeat(64)]) {
      const f = await get(`/v1/pins/${sha}`, FIXTURE_P);
      expect(f.status).toBe(200);
      expectNoReal(f.body);
      const r = await get(`/v1/pins/${sha}`, ALLOWED);
      expect(r.status).toBe(200);
      expectNoFixture(r.body);
    }
    // And again in the other order: the per-folder cache never hands one tree's table to the other.
    expectNoReal((await get(`/v1/pins/${'f'.repeat(64)}`, FIXTURE_P)).body);
  });

  it('list (S2): only fixture rows', async () => {
    const r = await get('/v1/traces', FIXTURE_P);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(4);
    expect(new Set(r.body.rows.map((x: any) => x.session_id))).toEqual(new Set([FX.sidA, FX.sidB, FX.sidOutside]));
    expect(r.body.rows[0].task_id).toBe(FX.taskId);
    expectNoReal(r.body);
  });

  it('search (S2 filters and pages): only fixture rows', async () => {
    for (const q of ['l2_class=plan', 'why=sample', 'mode=replay', 'l2_class=build', 'limit=1&offset=1', 'limit=200&offset=3', 'why=nothing']) {
      const r = await get(`/v1/traces?${q}`, FIXTURE_P);
      expect(r.status, q).toBe(200);
      for (const row of r.body.rows) expect([FX.sidA, FX.sidB, FX.sidOutside], q).toContain(row.session_id);
      expectNoReal(r.body);
    }
  });

  it('detail (S3): a fixture session is served; a real session id is not indexed', async () => {
    const ok = await get(`/v1/traces/${FX.sidA}`, FIXTURE_P);
    expect(ok.status).toBe(200);
    expect(ok.body.summary.title).toBe('Fixture session');
    expectNoReal(ok.body);
    for (const sid of [REAL.sidA, REAL.sidB, REAL.sidOutside]) {
      const r = await get(`/v1/traces/${sid}`, FIXTURE_P);
      expect(r.status, sid).toBe(404);
      expect(r.body).toEqual({ error: 'session_not_indexed' });
    }
  });

  it('steps (S3 ?agent_id): fixture steps only; a real run is never served', async () => {
    const ok = await get(`/v1/traces/${FX.sidA}?agent_id=${FX.subAgent}`, FIXTURE_P);
    expect(ok.status).toBe(200);
    expect(ok.body.runs[0].spans[0].preview).toBe('fixture step 0');
    expectNoReal(ok.body);
    const r = await get(`/v1/traces/${REAL.sidA}?agent_id=${REAL.subAgent}`, FIXTURE_P);
    expect(r.status).toBe(404);
    expectNoReal(r.body);
    const cross = await get(`/v1/traces/${FX.sidA}?agent_id=${REAL.subAgent}`, FIXTURE_P);
    expect(cross.status).toBe(404);
  });

  it('dry run: refused for a fixture principal (403), before the body is read', async () => {
    const r = await fetch(`${base}/grade/dry-run`, { method: 'POST', headers: { ...as(FIXTURE_P), 'content-type': 'application/json' }, body: '{"grader":"x@1.0.0","output":"y"}' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'fixture_principal_refused', message: 'a fixture principal gets no dry run' });
  });
});

describe('fixture principal: file route, a fixture index row that points at a real layer-1 file', () => {
  const tampered = buildFixture();
  let srv: Server;
  let url: string;
  beforeAll(async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => { prepare(sql: string): { run(...a: unknown[]): void }; close(): void };
    };
    const db = new DatabaseSync(tampered.indexPath);
    const realFile = join(real.trajectoryRoot, '2026-11', `${REAL.sidA}.jsonl`);
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('h', 'claude-code', 'root', REAL.sidA, null, 'main', 't', 't', 1, '[]', '/x/tampered.jsonl', 'live', realFile, 't');
    db.prepare('UPDATE sessions SET trajectory_ref = ? WHERE session_id = ? AND agent_id IS NULL').run(realFile, FX.sidB);
    db.close();
    writeFileSync(join(tampered.selectDir, 'candidates-2026-11-03.jsonl'), `${JSON.stringify({ session_id: REAL.sidA, agent_id: null })}\n`);
    srv = await startStudioServer(0, { ...opts(), fixtureSources: tampered });
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => srv.close(r));
    rmSync(tampered.root, { recursive: true, force: true });
  });

  it('the real file is refused by the path guard (no_trajectory), for a real id and for a fixture id', async () => {
    for (const sid of [REAL.sidA, FX.sidB]) {
      const r = await fetch(`${url}/v1/traces/${sid}`, { headers: as(FIXTURE_P) });
      expect(r.status, sid).toBe(404);
      const body = await r.json();
      expect(body).toEqual({ error: 'no_trajectory' });
    }
    const list = await (await fetch(`${url}/v1/traces`, { headers: as(FIXTURE_P) })).json();
    expect(list.rows.every((x: any) => x.has_trajectory === false)).toBe(true);
    expect(JSON.stringify(list)).not.toContain('Realtree');
  });
});

describe('real principal: never a fixture row', () => {
  it('list and search: only real rows', async () => {
    for (const q of ['', '?l2_class=plan', '?why=sample', '?limit=1&offset=1']) {
      const r = await get(`/v1/traces${q}`, ALLOWED);
      expect(r.status, q).toBe(200);
      for (const row of r.body.rows) expect([REAL.sidA, REAL.sidB, REAL.sidOutside], q).toContain(row.session_id);
      expectNoFixture(r.body);
    }
  });

  it('detail and steps: a fixture session id is not indexed for a real principal', async () => {
    const ok = await get(`/v1/traces/${REAL.sidA}?agent_id=${REAL.subAgent}`, ALLOWED);
    expect(ok.status).toBe(200);
    expectNoFixture(ok.body);
    expect((await get(`/v1/traces/${FX.sidA}`, ALLOWED)).status).toBe(404);
    expect((await get(`/v1/traces/${FX.sidA}?agent_id=${FX.subAgent}`, ALLOWED)).status).toBe(404);
  });

  it('a principal on neither list: 403 on every content route', async () => {
    for (const p of ['/v1/traces', `/v1/traces/${FX.sidA}`, `/v1/traces/${REAL.sidA}`]) expect((await get(p, OTHER)).status).toBe(403);
  });
});

describe('sourcesFor: one place, fail closed', () => {
  it('fixture -> fixture tree; real -> real sources; fixture without a tree or an unknown kind -> nothing', () => {
    expect(sourcesFor({ kind: 'fixture' }, { sources: real, fixtureSources: fix })).toBe(fix);
    expect(sourcesFor({ kind: 'real' }, { sources: real, fixtureSources: fix })).toBe(real);
    expect(sourcesFor({ kind: 'fixture' }, { sources: real })).toBeNull();
    expect(sourcesFor({ kind: 'other' as never }, { sources: real, fixtureSources: fix })).toBeNull();
  });

  it('route(): a fixture principal on a serve without fixture sources gets 403, never the real rows', async () => {
    const o = opts();
    delete o.fixtureSources;
    for (const p of ['/v1/traces', `/v1/traces/${REAL.sidA}`, `/v1/traces/${REAL.sidA}?agent_id=${REAL.subAgent}`]) {
      const a = await route('GET', p, `Bearer ${webToken(FIXTURE_P)}`, o);
      expect(a.status, p).toBe(403);
      expect(a.body).toEqual({ error: 'no_sources_for_principal' });
    }
  });
});

describe('start refusals', () => {
  it('a principal on both lists refuses the start', async () => {
    const o = opts();
    o.auth = { ...o.auth, fixturePrincipals: new Set([ALLOWED]) };
    await expect(startStudioServer(0, o)).rejects.toThrow(/both the real and the fixture list/);
  });

  it('fixture principals without fixture sources refuse the start', async () => {
    const o = opts();
    delete o.fixtureSources;
    await expect(startStudioServer(0, o)).rejects.toThrow(/need fixture sources/);
  });

  it('fixture sources that overlap the real sources refuse the start', async () => {
    await expect(startStudioServer(0, { ...opts(), fixtureSources: real })).rejects.toThrow(/real index|overlaps/);
    await expect(startStudioServer(0, { ...opts(), fixtureSources: { ...fix, trajectoryRoot: real.trajectoryRoot } })).rejects.toThrow(/overlaps/);
  });
});

describe('fixtureSourcesAt: the --fixture-root gate', () => {
  it('accepts a tree of buildFixture()', () => {
    const fx = fixtureSourcesAt(fix.root, real);
    expect(fx.selectDir.endsWith('trace-select')).toBe(true);
  });

  it('refuses a missing root, a tree without the marker, a symbolic link, and an overlap with a real source', () => {
    expect(() => fixtureSourcesAt(join(fix.root, 'nope'), real)).toThrow(/does not exist/);
    const bare = mkdtempSync(join(tmpdir(), 'tma-studio-bare-'));
    expect(() => fixtureSourcesAt(bare, real)).toThrow(/marker/);
    writeFileSync(join(bare, FIXTURE_MARKER), '{"schema":"other"}');
    expect(() => fixtureSourcesAt(bare, real)).toThrow(/marker is not/);
    rmSync(bare, { recursive: true, force: true });

    const linked = buildFixture();
    symlinkSync(join(real.selectDir, 'candidates-2026-11-02.jsonl'), join(linked.selectDir, 'candidates-2026-11-09.jsonl'));
    expect(() => fixtureSourcesAt(linked.root, real)).toThrow(/symbolic link/);
    rmSync(linked.root, { recursive: true, force: true });

    // The real tree itself (it carries a marker, since the test built it with buildFixture) is refused.
    expect(() => fixtureSourcesAt(real.root, real)).toThrow(/overlaps/);
    // A fixture tree inside a real source folder is refused.
    const nested = buildFixture(join(real.trajectoryRoot, 'nested-fixture'));
    expect(() => fixtureSourcesAt(nested.root, real)).toThrow(/overlaps/);
    rmSync(nested.root, { recursive: true, force: true });
  });

  it('buildFixture refuses a root that is not empty', () => {
    expect(() => buildFixture(fix.root)).toThrow(/not empty/);
  });
});
