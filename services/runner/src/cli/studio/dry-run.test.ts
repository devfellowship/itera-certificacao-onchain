// `POST /grade/dry-run` of `tma studio serve` (task C5-T10, Q-C5-2b = A): login, 405 elsewhere, 413, 415, 429,
// 504, the judge model gate (A11 Q1 = B), a code grader that passes and one that fails, the TMA API sees only
// GET /auth/me, the temp dir is gone after every call (also after a throw), and the grader root is not written.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiIntrospect } from './auth.js';
import { DRY_RUN_MAX_BODY } from './dry-run.js';
import type { JudgeFn } from '../eval/judge.js';
import { startStudioServer } from './server.js';
import { ALLOWED, buildFixture, fakeApi, OTHER, signToken, webToken } from './fixture.test-helpers.js';

const ORIGIN = 'https://studio.fixture.test';
const fx = buildFixture();
const work = mkdtempSync(join(tmpdir(), 'tma-studio-dry-'));
const graderRoot = join(work, 'graders');
const tmpRoot = join(work, 'tmp');
const outside = join(work, 'outside');

// Synthetic code grader: workdir/output.txt must hold the word "ok". It also writes into its workdir (a temp dir).
const SAYS_OK = `import argparse, json, os, sys
ap = argparse.ArgumentParser()
ap.add_argument('--spec', required=True)
ap.add_argument('--workdir', required=True)
ap.add_argument('--trajectory')
a = ap.parse_args()
open(os.path.join(a.workdir, 'scratch.txt'), 'w').write('written')
spec = json.load(open(a.spec))
words = open(os.path.join(a.workdir, 'output.txt')).read().split()
want = spec.get('word', 'ok')
st = 'pass' if want in words else 'fail'
print(json.dumps({'schema': 'tma-grader-result/1', 'status': st}))
`;
const SLOW = `import time\ntime.sleep(20)\n`;

function writeJson(p: string, v: unknown) {
  writeFileSync(p, JSON.stringify(v));
}
function grader(id: string, semver: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = join(graderRoot, id, semver);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'grader.json'), { schema: 'tma-grader/1', id, semver, ...manifest });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

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

// The fake TMA API, over HTTP, with a request log: method + path of every call.
const apiLog: string[] = [];
let api: Server;
let server: Server;
let base: string;
const judgeCalls: string[] = [];
const judgeFn: JudgeFn = async (input) => {
  judgeCalls.push(input.model);
  if (input.rubric.includes('THROW')) throw new Error('judge runner crashed');
  const output = readFileSync(input.outputHandle, 'utf-8');
  return { infra_ok: true, pass: output.includes(input.expected), reason: null };
};
let before = '';

beforeAll(async () => {
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(join(outside, '1.0.0'), { recursive: true });
  writeJson(join(outside, '1.0.0', 'grader.json'), { schema: 'tma-grader/1', id: 'escape', semver: '1.0.0', kind: 'code', entry: 'grade.py' });
  grader('says-ok', '1.0.0', { kind: 'code', entry: 'grade.py' }, { 'grade.py': SAYS_OK, 'fixtures/reference/spec.json': '{"word": "ok"}' });
  grader('slow', '1.0.0', { kind: 'code', entry: 'grade.py' }, { 'grade.py': SLOW });
  grader('judge-ok', '1.0.0', { kind: 'judge', model: 'anthropic/claude-haiku-5.5' }, {
    'rubric.md': 'Fail when the output misses the expected text.',
    'calibration.json': JSON.stringify({ n_labels: 30, n_test: 20, tp: 10, fn: 0, tn: 10, fp: 0 }),
  });
  grader('judge-local', '1.0.0', { kind: 'judge', model: 'ollama/qwen3:8b' }, { 'rubric.md': 'r' });
  grader('judge-throws', '1.0.0', { kind: 'judge', model: 'anthropic/claude-sonnet-5.5' }, { 'rubric.md': 'THROW' });
  grader('judge-gpt', '1.0.0', { kind: 'judge', model: 'openai/gpt-5.1' }, { 'rubric.md': 'r' });
  grader('judge-or', '1.0.0', { kind: 'judge', model: 'openrouter/zai/glm-5.3' }, { 'rubric.md': 'r' });
  symlinkSync(outside, join(graderRoot, 'escape'));
  before = digestTree(graderRoot);

  const introspect = fakeApi();
  api = createServer((req, res) => {
    apiLog.push(`${req.method} ${req.url}`);
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    void introspect(token).then((r) => {
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  server = await startStudioServer(0, {
    sources: fx,
    auth: { introspect: apiIntrospect(apiBase), allowPrincipals: new Set([ALLOWED]) },
    allowOrigins: new Set([ORIGIN]),
    dryRun: { graderRoot, judgeFn, timeoutMs: 2_000, tmpRoot },
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => api.close(r));
  rmSync(fx.root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const auth = (token = webToken()) => ({ authorization: `Bearer ${token}` });
const post = (body: unknown, headers: Record<string, string> = auth()) =>
  fetch(`${base}/grade/dry-run`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const tmpEmpty = () => expect(readdirSync(tmpRoot)).toEqual([]);

describe('POST /grade/dry-run', () => {
  it('401 without a session, 401 for a CLI session, 403 for a principal not on the allow-list', async () => {
    const none = await post({ grader: 'says-ok@1.0.0', output: 'ok' }, {});
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'missing_token' });
    const now = Math.floor(Date.now() / 1000);
    const cli = await post({ grader: 'says-ok@1.0.0', output: 'ok' }, auth(signToken({ sub: ALLOWED, amr: 'dfl', sid: 's-1', iat: now, exp: now + 600 })));
    expect(cli.status).toBe(401);
    expect(await cli.json()).toEqual({ error: 'cli_session_refused' });
    expect((await post({ grader: 'says-ok@1.0.0', output: 'ok' }, auth(webToken(OTHER)))).status).toBe(403);
  });

  it('405 for every other method on the path, and for POST on any other path', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const r = await fetch(`${base}/grade/dry-run`, { method, headers: auth(), body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
      expect(r.status, method).toBe(405);
      expect(r.headers.get('allow')).toBe('POST, OPTIONS');
    }
    for (const p of ['/grade/dry-run/', '/grade', '/v1/grade/dry-run', '/grade/dry-run/x', '/v1/traces']) {
      const r = await fetch(`${base}${p}`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: '{}' });
      expect(r.status, p).toBe(405);
    }
  });

  it('a code grader that passes', async () => {
    const r = await post({ grader: 'says-ok@1.0.0', output: 'all ok here' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const a = (await r.json()) as Record<string, any>;
    expect(a).toMatchObject({ pass: true, score: 100, stored: false, details: { infra_ok: true, reason: null, grader: { id: 'says-ok', version: '1.0.0', kind: 'code' }, format: 'tma-eval-dry-run/1' } });
    expect(typeof a.durationMs).toBe('number');
    expect(a.details.output_sha256).toBe(createHash('sha256').update('all ok here').digest('hex'));
    tmpEmpty();
  });

  it('a code grader that fails', async () => {
    const a = (await (await post({ grader: 'says-ok@1.0.0', output: 'nope' })).json()) as Record<string, any>;
    expect(a).toMatchObject({ pass: false, score: 0, stored: false, details: { infra_ok: true } });
    tmpEmpty();
  });

  it('refuses a judge model outside A11 Q1 = B with 422, before any execution', async () => {
    const calls = judgeCalls.length;
    for (const id of ['judge-gpt', 'judge-or']) {
      const r = await post({ grader: `${id}@1.0.0`, output: 'x', expected: 'x' });
      expect(r.status, id).toBe(422);
      const body = (await r.json()) as { error: string; message: string; stored: boolean };
      expect(body.error).toBe('judge_model_not_allowed');
      expect(body.message).toMatch(/A11 Q1 = B/);
      expect(body.stored).toBe(false);
    }
    expect(judgeCalls.length).toBe(calls);
    tmpEmpty();
  });

  it('runs an allowed judge through the kit judge path (fleet Claude; local ollama/)', async () => {
    const ok = (await (await post({ grader: 'judge-ok@1.0.0', output: 'the answer is 42', expected: '42' })).json()) as Record<string, any>;
    expect(ok).toMatchObject({ pass: true, score: 100, stored: false, details: { infra_ok: true, grader: { kind: 'judge' } } });
    const no = (await (await post({ grader: 'judge-ok@1.0.0', output: 'nothing', expected: '42' })).json()) as Record<string, any>;
    expect(no).toMatchObject({ pass: false, score: 0 });
    // Not calibrated: a side signal only (no decisive grader, so no score).
    const local = (await (await post({ grader: 'judge-local@1.0.0', output: 'x', expected: 'x' })).json()) as Record<string, any>;
    expect(local).toMatchObject({ pass: false, score: null, details: { infra_ok: true } });
    expect(local.details.reason).toMatch(/judge_not_calibrated/);
    expect(judgeCalls.slice(-3)).toEqual(['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-5.5', 'ollama/qwen3:8b']);
    tmpEmpty();
  });

  it('removes the temp dir also after a throw (500)', async () => {
    const r = await post({ grader: 'judge-throws@1.0.0', output: 'x', expected: 'x' });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'dry_run_failed', stored: false });
    tmpEmpty();
  });

  it('413 above 256 KB', async () => {
    const r = await post({ grader: 'says-ok@1.0.0', output: 'o'.repeat(DRY_RUN_MAX_BODY) });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ error: 'body_too_large' });
    tmpEmpty();
  });

  it('400 for a bad body or a path traversal; 404 for an unknown grader; 415 for another content type', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post({ grader: 'says-ok@1.0.0', output: 'ok', case: 'x' })).status).toBe(400);
    expect((await post({ grader: 'says-ok', output: 'ok' })).status).toBe(400);
    expect((await post({ grader: 'says-ok@1.0.0' })).status).toBe(400);
    for (const g of ['../outside@1.0.0', 'says-ok@../../x', '..@1.0.0', 'says-ok/../slow@1.0.0']) {
      const r = await post({ grader: g, output: 'ok' });
      expect(r.status, g).toBe(400);
    }
    // A symlink in the root that points outside it is refused.
    const esc = await post({ grader: 'escape@1.0.0', output: 'ok' });
    expect(esc.status).toBe(400);
    expect(await esc.json()).toMatchObject({ error: 'bad_grader' });
    expect((await post({ grader: 'nobody@1.0.0', output: 'ok' })).status).toBe(404);
    expect((await post({ grader: 'says-ok@9.9.9', output: 'ok' })).status).toBe(404);
    const txt = await fetch(`${base}/grade/dry-run`, { method: 'POST', headers: { ...auth(), 'content-type': 'text/plain' }, body: '{}' });
    expect(txt.status).toBe(415);
    tmpEmpty();
  });

  it('429 while a dry run runs; 504 when it passes the timeout; the temp dir is gone after', async () => {
    const slow = post({ grader: 'slow@1.0.0', output: 'x' });
    await new Promise((r) => setTimeout(r, 300));
    const busy = await post({ grader: 'says-ok@1.0.0', output: 'ok' });
    expect(busy.status).toBe(429);
    expect(await busy.json()).toMatchObject({ error: 'busy' });
    const r = await slow;
    expect(r.status).toBe(504);
    expect(await r.json()).toEqual({ error: 'dry_run_timeout', message: 'the dry run did not end in time', stored: false });
    tmpEmpty();
    // The gate opens again.
    expect((await post({ grader: 'says-ok@1.0.0', output: 'ok' })).status).toBe(200);
  }, 15_000);

  it('CORS: the preflight of an allowed origin allows POST and content-type; another origin gets 403', async () => {
    const pre = await fetch(`${base}/grade/dry-run`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(pre.headers.get('access-control-allow-methods')).toBe('POST');
    expect(pre.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    const bad = await fetch(`${base}/grade/dry-run`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    const ok = await post({ grader: 'says-ok@1.0.0', output: 'ok' }, { ...auth(), origin: ORIGIN });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('the TMA API received only GET /auth/me', () => {
    expect(apiLog.length).toBeGreaterThan(0);
    expect(new Set(apiLog)).toEqual(new Set(['GET /auth/me']));
  });

  it('no file appeared in the grader root, and the temp root is empty', () => {
    expect(digestTree(graderRoot)).toBe(before);
    tmpEmpty();
  });
});

describe('POST /grade/dry-run without a grader library', () => {
  it('answers 503 grader_library_not_configured', async () => {
    const s = await startStudioServer(0, { sources: fx, auth: { introspect: fakeApi(), allowPrincipals: new Set([ALLOWED]) }, allowOrigins: new Set() });
    const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/grade/dry-run`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ grader: 'says-ok@1.0.0', output: 'ok' }),
    });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'grader_library_not_configured' });
    await new Promise((res) => s.close(res));
  });
});
