import { statSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadSessionFile, sessionPath } from '../session.js';
import { API, TOKEN, captureIo, tempEnv } from '../test/fixtures.js';
import { clientName, login, logout } from './login.js';

const DEVICE = 'D'.repeat(43);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const START = { device_code: DEVICE, user_code: 'ABCD-EFGH', verification_url: 'https://web2.test/cli?code=ABCD-EFGH', interval: 5, expires_in: 600 };
const APPROVED = { sessionToken: TOKEN, expiresAt: '2026-10-27T12:00:00.000Z', sessionId: '6b1b8c55-2f0e-4c1e-9a77-4f3f0b1c2d3e', principal: 'dfl:00000000-0000-4000-8000-0000000000aa' };

/** A fake API that answers the token polls from a list. */
function fakeApi(polls: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).endsWith('/auth/cli/start')) return json(200, START);
    if (String(url).endsWith('/auth/cli/token')) return polls.shift() ?? json(500, {});
    if (String(url).includes('/me/cli-sessions/')) return new Response(null, { status: 204 });
    throw new Error(`unexpected ${String(url)}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function clock() {
  let t = Date.parse('2026-10-26T12:00:00Z');
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps };
}

describe('tma login', () => {
  it('starts, shows the URL and the code, polls (pending, slow_down), then stores the session with mode 600', async () => {
    const env = tempEnv();
    const io = captureIo();
    const c = clock();
    const { fetchImpl, calls } = fakeApi([json(428, { error: 'authorization_pending' }), json(429, { error: 'slow_down' }), json(200, APPROVED)]);
    const code = await login([], io, { env, fetchImpl, sleep: c.sleep, now: c.now, host: () => 'samuel-vps' });
    expect(code).toBe(0);
    expect(io.errText()).toContain('https://web2.test/cli?code=ABCD-EFGH');
    expect(io.errText()).toContain('ABCD-EFGH');
    expect(c.sleeps).toEqual([5000, 5000, 10000]);
    const start = calls[0]!;
    expect(start.url).toBe(`${API}/auth/cli/start`);
    expect(JSON.parse(String(start.init.body))).toEqual({ client_name: clientName('samuel-vps') });
    for (const p of calls.slice(1)) expect(JSON.parse(String(p.init.body))).toEqual({ device_code: DEVICE });
    const s = loadSessionFile(env)!;
    expect(s).toMatchObject({ api_url: API, principal: APPROVED.principal, session_id: APPROVED.sessionId, session_token: TOKEN });
    if (process.platform !== 'win32') expect(statSync(sessionPath(env)).mode & 0o777).toBe(0o600);
    expect(io.outText() + io.errText()).not.toContain(TOKEN);
    expect(io.outText() + io.errText()).not.toContain(DEVICE);
  });

  it('a denied login and an expired code end with an error and no session file', async () => {
    for (const [answer, re] of [[json(400, { error: 'access_denied' }), /denied/], [json(400, { error: 'code_expired' }), /expired/]] as const) {
      const env = tempEnv();
      const c = clock();
      const { fetchImpl } = fakeApi([answer]);
      await expect(login([], captureIo(), { env, fetchImpl, sleep: c.sleep, now: c.now })).rejects.toThrow(re);
      expect(loadSessionFile(env)).toBeNull();
    }
  });

  it('stops at the code deadline without a session', async () => {
    const env = tempEnv();
    const c = clock();
    const { fetchImpl } = fakeApi(Array.from({ length: 200 }, () => json(428, { error: 'authorization_pending' })));
    await expect(login([], captureIo(), { env, fetchImpl, sleep: c.sleep, now: c.now })).rejects.toThrow(/expired before it was approved/);
    expect(loadSessionFile(env)).toBeNull();
  });

  it('the client name is safe for the API (no quote mark, at most 60 characters)', () => {
    expect(clientName(`evil"host'\n${'x'.repeat(80)}`)).toMatch(/^[A-Za-z0-9 .,:;/()+_%$=&#-]{1,60}$/);
  });
});

describe('tma logout', () => {
  it('revokes the session on the API and deletes the file', async () => {
    const env = tempEnv();
    const c = clock();
    const api = fakeApi([json(200, APPROVED)]);
    await login([], captureIo(), { env, fetchImpl: api.fetchImpl, sleep: c.sleep, now: c.now });
    const io = captureIo();
    await logout([], io, { env, fetchImpl: api.fetchImpl, now: c.now });
    const del = api.calls.find((x) => x.init.method === 'DELETE')!;
    expect(del.url).toBe(`${API}/me/cli-sessions/${APPROVED.sessionId}`);
    expect(new Headers(del.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(loadSessionFile(env)).toBeNull();
    expect(io.outText()).toContain('Logged out');
  });
});
