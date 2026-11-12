// `tma studio serve` end to end on a fixture tree (task C5-T11): 401 without a session, 405 on every
// write method, 127.0.0.1 only, S2 list and S3 trace content, the path guard, and no write to the sources.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIND_HOST, startStudioServer } from './server.js';
import { ALLOWED, buildFixture, fakeApi, OTHER, SID_A, SID_B, SID_OUTSIDE, SUB_AGENT, webToken } from './fixture.test-helpers.js';

const fx = buildFixture();
const ORIGIN = 'https://studio.fixture.test';
let server: Server;
let base: string;
const logs: string[] = [];

function digestTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      h.update(`${p}:${st.mtimeMs}:${st.size}\n`);
      if (st.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}
let before = '';

beforeAll(async () => {
  before = digestTree(fx.root);
  server = await startStudioServer(0, {
    sources: fx,
    auth: { introspect: fakeApi(), allowPrincipals: new Set([ALLOWED]) },
    allowOrigins: new Set([ORIGIN]),
    log: (l) => logs.push(l),
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(fx.root, { recursive: true, force: true });
});

const auth = (token = webToken()) => ({ authorization: `Bearer ${token}` });
const get = (path: string, headers: Record<string, string> = auth()) => fetch(`${base}${path}`, { headers });

describe('tma studio serve', () => {
  it('binds 127.0.0.1 only', () => {
    expect(BIND_HOST).toBe('127.0.0.1');
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('health needs no login and shows nothing', async () => {
    const r = await fetch(`${base}/v1/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('answers 401 without a session on every content route', async () => {
    for (const p of ['/v1/traces', `/v1/traces/${SID_A}`]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'missing_token' });
    }
  });

  it('answers 403 for a valid session of another principal', async () => {
    expect((await get('/v1/traces', auth(webToken(OTHER)))).status).toBe(403);
  });

  it('answers 405 on every write method, with or without a session', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const p of ['/v1/traces', `/v1/traces/${SID_A}`, '/v1/health', '/anything']) {
        const r = await fetch(`${base}${p}`, { method, headers: auth(), body: method === 'DELETE' ? undefined : '{}' });
        expect(r.status, `${method} ${p}`).toBe(405);
        expect(r.headers.get('allow')).toBe('GET, OPTIONS');
      }
    }
  });

  it('S2: lists the newest selection with pin status, a clipped task summary and only known fields', async () => {
    const r = await get('/v1/traces');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as { source: { selection_day: string }; total: number; rows: Record<string, any>[] };
    expect(body.source.selection_day).toBe('2026-11-02');
    expect(body.total).toBe(4);
    const main = body.rows.find((x) => x.session_id === SID_A && x.agent_id === null)!;
    expect(main.pin).toEqual({ pin_sha256: 'f'.repeat(64), complete: false, missing: ['repo', 'base_sha'], layer1: true });
    expect(main.task_summary.before).toHaveLength(280);
    expect(main.task_summary.outcome).toBe('Fixture outcome.');
    expect(main.has_trajectory).toBe(true);
    expect(main.signals).toEqual({ revert: false, ci_rerun: true, correction: null, junk: null });
    expect(main).not.toHaveProperty('private_note');
    expect(body.rows.find((x) => x.session_id === SID_B)!.has_trajectory).toBe(false);
    // A layer-1 file outside the trajectory root does not count as a trajectory.
    expect(body.rows.find((x) => x.session_id === SID_OUTSIDE)!.has_trajectory).toBe(false);
  });

  it('S2: filters and pages', async () => {
    const plan = (await (await get('/v1/traces?l2_class=plan')).json()) as { total: number; rows: { session_id: string }[] };
    expect(plan.total).toBe(1);
    expect(plan.rows[0]!.session_id).toBe(SID_B);
    const page = (await (await get('/v1/traces?limit=1&offset=1')).json()) as { rows: { agent_id: string }[] };
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.agent_id).toBe(SUB_AGENT);
    expect((await get('/v1/traces?limit=0')).status).toBe(400);
    expect((await get('/v1/traces?limit=201')).status).toBe(400);
    expect((await get('/v1/traces?why=a%20b')).status).toBe(400);
  });

  it('S3: serves the summary, the runs with their steps and the first failure', async () => {
    const r = await get(`/v1/traces/${SID_A}`);
    expect(r.status).toBe(200);
    const t = (await r.json()) as Record<string, any>;
    expect(t.summary.title).toBe('Fixture session');
    expect(t.runs).toHaveLength(2);
    expect(t.runs[0].spans[0].preview).toBe('fixture step 0');
    expect(t.runs[0].spans[0]).not.toHaveProperty('secret_like');
    expect(t.first_failure).toMatchObject({ agent_id: SUB_AGENT, seq: 0, ok: false });
    expect(t.task_summary.expected).toBe('Fixture expected state.');
    expect(t.index).not.toHaveProperty('trajectory_ref');
    expect(JSON.stringify(t)).not.toContain(fx.root);
  });

  it('S3: one subagent with ?agent_id', async () => {
    const t = (await (await get(`/v1/traces/${SID_A}?agent_id=${SUB_AGENT}`)).json()) as Record<string, any>;
    expect(t.runs).toHaveLength(1);
    expect(t.candidate.why).toBe('sample');
    expect((await get(`/v1/traces/${SID_A}?agent_id=nobody`)).status).toBe(404);
  });

  it('S3: 404 for a session with no layer-1 file, outside the root, or not indexed; 400 for a bad id', async () => {
    expect(await (await get(`/v1/traces/${SID_B}`)).json()).toEqual({ error: 'no_trajectory' });
    expect(await (await get(`/v1/traces/${SID_OUTSIDE}`)).json()).toEqual({ error: 'no_trajectory' });
    expect((await get('/v1/traces/dddddddd-0000-4000-8000-00000000000d')).status).toBe(404);
    expect((await get('/v1/traces/..%2F..%2Fetc')).status).toBe(400);
    expect((await get('/v1/nothing')).status).toBe(404);
  });

  it('CORS: an allowed origin gets the headers and a preflight; another origin does not', async () => {
    const ok = await get('/v1/traces', { ...auth(), origin: ORIGIN });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const other = await get('/v1/traces', { ...auth(), origin: 'https://evil.example' });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await fetch(`${base}/v1/traces`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET');
    const preBad = await fetch(`${base}/v1/traces`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(preBad.status).toBe(403);
  });

  it('never logs a token', () => {
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toMatch(/eyJ|Bearer/);
  });

  it('wrote nothing to the sources', () => {
    expect(digestTree(fx.root)).toBe(before);
  });
});
