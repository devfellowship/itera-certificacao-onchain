import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSessionFile, requireSession, SESSION_FORMAT, sessionPath, writeSession } from './session.js';
import { API, TOKEN, tempEnv } from './test/fixtures.js';

const session = (over = {}) => ({
  format: SESSION_FORMAT,
  api_url: API,
  principal: 'dfl:00000000-0000-4000-8000-0000000000aa',
  session_id: '6b1b8c55-2f0e-4c1e-9a77-4f3f0b1c2d3e',
  session_token: TOKEN,
  expires_at: '2026-10-27T12:00:00.000Z',
  ...over,
});
const NOW = Date.parse('2026-10-26T12:00:00Z');

describe.skipIf(process.platform === 'win32')('session file', () => {
  it('is written with mode 600 in a directory of mode 700', () => {
    const env = tempEnv();
    const path = writeSession(session() as never, env);
    expect(path).toBe(sessionPath(env));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(loadSessionFile(env)?.session_token).toBe(TOKEN);
  });

  it('a file that other users can read is refused, and the error does not print the token', () => {
    const env = tempEnv();
    const path = writeSession(session() as never, env);
    chmodSync(path, 0o644);
    expect(() => loadSessionFile(env)).toThrow(/chmod 600/);
    try {
      loadSessionFile(env);
    } catch (e) {
      expect(String(e)).not.toContain(TOKEN);
    }
  });

  it('requireSession refuses no login, an expired session, a session of another API, and a broken file', () => {
    const env = tempEnv();
    expect(() => requireSession(API, NOW, env)).toThrow(/not logged in/);
    writeSession(session({ expires_at: '2026-10-26T11:59:59.000Z' }) as never, env);
    expect(() => requireSession(API, NOW, env)).toThrow(/expired/);
    writeSession(session() as never, env);
    expect(() => requireSession('https://other.test', NOW, env)).toThrow(/not https:\/\/other.test/);
    expect(requireSession(API, NOW, env).principal).toMatch(/^dfl:/);
    writeFileSync(sessionPath(env), '{"format":"x"}', { mode: 0o600 });
    expect(() => requireSession(API, NOW, env)).toThrow(/not a tma session file/);
  });
});
