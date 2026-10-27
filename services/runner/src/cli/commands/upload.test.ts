import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateLocalResult } from '@itera/contracts';
import { describe, expect, it, vi } from 'vitest';
import { legacyToLocalResults } from '../legacy.js';
import { SESSION_FORMAT, writeSession } from '../session.js';
import { AGENT, API, TOKEN, captureIo, legacyMiningFile, tempEnv, tmaScoreResult } from '../test/fixtures.js';
import { findSecrets, prepareUpload, upload } from './upload.js';

const OTHER_AGENT = '22222222-3333-4444-8555-666666666666';

function fileWith(value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tma-upload-')), 'result.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

function loggedIn(): NodeJS.ProcessEnv {
  const env = tempEnv();
  writeSession({ format: SESSION_FORMAT, api_url: API, principal: 'dfl:x', session_id: 's', session_token: TOKEN, expires_at: '2099-01-01T00:00:00.000Z' }, env);
  return env;
}

function fakeApi(status = 201, action = 'inserted') {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ evaluation_id: 'e0e0e0e0-1111-4222-8333-444444444444', run_id: 'r', action, result_origin: 'self_declared', url: 'https://web2.test/evaluations/e0' }), { status }),
  );
}
const sent = (f: ReturnType<typeof fakeApi>) => (f.mock.calls as unknown as Array<[string, RequestInit]>).map(([u, i]) => ({ url: u, body: JSON.parse(String(i.body)), auth: new Headers(i.headers).get('authorization') }));

describe('tma upload — a tma-local-result/1 file', () => {
  it('sends exactly the file to POST /self-declared-results with the session', async () => {
    const result = tmaScoreResult();
    const f = fakeApi();
    const io = captureIo();
    expect(await upload([fileWith(result)], io, { env: loggedIn(), fetchImpl: f as unknown as typeof fetch })).toBe(0);
    const [call] = sent(f);
    expect(call!.url).toBe(`${API}/self-declared-results`);
    expect(call!.body).toEqual(result);
    expect(call!.auth).toBe(`Bearer ${TOKEN}`);
    expect(io.outText()).toContain('inserted');
    expect(io.outText()).toContain('self-declared');
    expect(io.outText() + io.errText()).not.toContain(TOKEN);
  });

  it('--agent replaces the agent id', async () => {
    const f = fakeApi();
    await upload([fileWith(tmaScoreResult()), '--agent', OTHER_AGENT], captureIo(), { env: loggedIn(), fetchImpl: f as unknown as typeof fetch });
    expect(sent(f)[0]!.body.agent_id).toBe(OTHER_AGENT);
  });

  it('--dry-run prints the exact body and asks the API with ?dry_run=1', async () => {
    const result = tmaScoreResult();
    const f = fakeApi(200, 'inserted');
    const io = captureIo();
    await upload([fileWith(result), '--dry-run'], io, { env: loggedIn(), fetchImpl: f as unknown as typeof fetch });
    expect(JSON.parse(io.outText().split('\n').filter((l) => !l.includes('dry run OK')).join('\n'))).toEqual(result);
    expect(sent(f)[0]!.url).toBe(`${API}/self-declared-results?dry_run=1`);
    expect(io.outText()).toContain('dry run OK, it would be inserted');
  });

  it('--dry-run without a login checks locally and makes no call', async () => {
    const f = fakeApi();
    const io = captureIo();
    expect(await upload([fileWith(tmaScoreResult()), '--dry-run'], io, { env: tempEnv(), fetchImpl: f as unknown as typeof fetch })).toBe(0);
    expect(f).not.toHaveBeenCalled();
    expect(io.errText()).toContain('not logged in');
  });

  it('a real upload needs a login', async () => {
    await expect(upload([fileWith(tmaScoreResult())], captureIo(), { env: tempEnv() })).rejects.toThrow(/not logged in/);
  });

  it('an API refusal is printed with its code and the command fails', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'agent_not_found', message: 'agent not found' }), { status: 404 }));
    const io = captureIo();
    expect(await upload([fileWith(tmaScoreResult())], io, { env: loggedIn(), fetchImpl: f as unknown as typeof fetch })).toBe(1);
    expect(io.errText()).toContain('agent_not_found');
  });
});

describe('tma upload — nothing but numbers leaves the machine (plan Verification row 6)', () => {
  for (const [what, extra] of [
    ['actions', { actions: [{ type: 'edit' }] }],
    ['stdout', { stdout: 'log line' }],
    ['patch', { patch: 'diff --git a b' }],
    ['prompt', { prompt: 'you are' }],
  ] as const) {
    it(`a file with "${what}" is refused locally, with no network call`, async () => {
      const f = fakeApi();
      await expect(upload([fileWith(tmaScoreResult(extra))], captureIo(), { env: loggedIn(), fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(new RegExp(`unknown key|/${what}`));
      expect(f).not.toHaveBeenCalled();
    });
  }

  it('a value that looks like a model key or holds the session token is refused, with no network call', async () => {
    const f = fakeApi();
    const withKey = tmaScoreResult();
    withKey.executor.harness = 'opencode sk-or-v1-abcdef123456';
    await expect(upload([fileWith(withKey)], captureIo(), { env: loggedIn(), fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/looks like an API key/);
    expect(f).not.toHaveBeenCalled();
    expect(findSecrets({ a: { b: `x ${TOKEN}` } }, TOKEN).join()).toContain('/a/b holds the session token');
  });

  it('the body built from a real result file has no key outside the schema and no credential', () => {
    const [b] = prepareUpload(fileWith(tmaScoreResult()), { token: TOKEN });
    expect(validateLocalResult(b!.body).ok).toBe(true);
    const text = JSON.stringify(b!.body);
    expect(text).not.toMatch(/sk-or-/);
    expect(text).not.toContain(TOKEN);
  });

  it('a file that is not JSON is refused', () => {
    expect(() => prepareUpload(fileWith('{nope'), {})).toThrow(/not JSON/);
  });
});

describe('tma upload — an old tma-bench-import file', () => {
  it('converts each executor to one valid transcript-mining/1 body, with the numbers unchanged', () => {
    const old = legacyMiningFile();
    const bodies = legacyToLocalResults(old, { agentId: AGENT });
    expect(bodies.map((b) => b.executor)).toEqual(['opencode-go/deepseek-v4-pro', 'zai/glm-5.3#structured-output']);
    for (const [i, b] of bodies.entries()) {
      const v = validateLocalResult(b.body);
      expect(v.ok, JSON.stringify(v)).toBe(true);
      expect(b.body.metrics_shape).toBe('transcript-mining/1');
      // The fixture has pack_version '2': the task version is still 1, the version the old importer wrote.
      expect(b.body.task).toEqual({ catalog: { slug: 'dfl-transcript-mining', version: 1 } });
      expect(b.body.summary).toEqual(old.executors[i].summary);
      expect(b.body.runs).toEqual(old.executors[i].runs);
      expect(b.body.runner.execution).toBe('external');
    }
    expect(bodies[0]!.body.executor).toMatchObject({ provider: 'deepseek', route: 'opencode-go', variant: null });
    expect(bodies[1]!.body.executor).toMatchObject({ provider: 'zai', route: 'zai', variant: 'structured-output' });
  });

  it('the task version defaults to 1, never the pack version; --task-version overrides it (L9)', () => {
    const old = legacyMiningFile();
    old.format = 'tma-bench-import/trajectory-1';
    old.task = { ...old.task, slug: 'dfl-session-decision-trajectory-extraction', pack_id: 'dfl-session-decision-trajectory-extraction', pack_version: '2' };
    for (const b of legacyToLocalResults(old, { agentId: AGENT })) expect(b.body.task).toEqual({ catalog: { slug: 'dfl-session-decision-trajectory-extraction', version: 1 } });
    for (const b of legacyToLocalResults(old, { agentId: AGENT, taskVersion: 4 })) expect(b.body.task).toEqual({ catalog: { slug: 'dfl-session-decision-trajectory-extraction', version: 4 } });
    delete old.task.pack_version;
    expect(legacyToLocalResults(old, { agentId: AGENT })[0]!.body.task).toEqual({ catalog: { slug: 'dfl-session-decision-trajectory-extraction', version: 1 } });
  });

  it('a trajectory file becomes trajectory/1', () => {
    const old = legacyMiningFile();
    old.format = 'tma-bench-import/trajectory-1';
    expect(legacyToLocalResults(old, { agentId: AGENT })[0]!.body.metrics_shape).toBe('trajectory/1');
  });

  it('needs --agent, sends one body per executor, and --executor picks one', async () => {
    const file = fileWith(legacyMiningFile());
    await expect(upload([file], captureIo(), { env: loggedIn() })).rejects.toThrow(/needs --agent/);
    const f = fakeApi();
    await upload([file, '--agent', AGENT], captureIo(), { env: loggedIn(), fetchImpl: f as unknown as typeof fetch });
    expect(sent(f).map((c) => c.body.executor.model_id)).toEqual(['opencode-go/deepseek-v4-pro', 'zai/glm-5.3']);
    const g = fakeApi();
    await upload([file, '--agent', AGENT, '--executor', 'zai/glm-5.3', '--task-version', '3'], captureIo(), { env: loggedIn(), fetchImpl: g as unknown as typeof fetch });
    expect(sent(g)).toHaveLength(1);
    expect(sent(g)[0]!.body.task.catalog.version).toBe(3);
  });

  it('a key that the old parser allowed but the contract does not is still refused (no text field passes)', () => {
    const old = legacyMiningFile();
    old.executors[0].runs[0].note = 'free text';
    expect(() => prepareUpload(fileWith(old), { agentId: AGENT })).toThrow(/unknown key|note/);
  });
});
