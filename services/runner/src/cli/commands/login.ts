// `tma login` and `tma logout` (plan 20261026-tma-local-runner-and-self-declared-results, §4 "How
// login works", ADR-7; task L7). The device login of task L5:
//
//   1. POST /auth/cli/start → a user code (ABCD-EFGH) and the web2 URL /cli?code=ABCD-EFGH.
//   2. The user opens the URL on ANY device (a headless VPS works), signs in with DFL, clicks Allow.
//   3. The CLI polls POST /auth/cli/token and gets a 24 h TMA session ONE time.
//   4. The session goes to <config dir>/session.json, mode 600. The token is never printed.
import { hostname } from 'node:os';
import { apiCall, describeRefusal, type Fetch } from '../api.js';
import { parseArgs } from '../args.js';
import type { Command, Io } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { deleteSession, loadSessionFile, SESSION_FORMAT, writeSession } from '../session.js';
import { CLI_VERSION } from '../version.js';

export interface LoginDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  host?: () => string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `tma 0.1.0 on <host>`, reduced to the characters that the API accepts (1 to 60, no quote mark). */
export function clientName(host: string): string {
  const safeHost = host.replace(/[^A-Za-z0-9.-]/g, '').slice(0, 40) || 'unknown-host';
  return `tma ${CLI_VERSION} on ${safeHost}`.slice(0, 60);
}

const LOGIN_USAGE = 'usage: tma login';

export async function login(argv: string[], io: Io, deps: LoginDeps = {}): Promise<number> {
  const args = parseArgs(argv, {});
  if (args.positionals.length > 0) throw new CliError(LOGIN_USAGE);
  const env = deps.env ?? process.env;
  const base = apiUrl(env);
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;

  const start = await apiCall(base, '/auth/cli/start', {
    method: 'POST',
    body: { client_name: clientName((deps.host ?? hostname)()) },
    fetchImpl: deps.fetchImpl,
  });
  const b = start.body ?? {};
  if (start.status !== 200 || typeof b.device_code !== 'string' || typeof b.user_code !== 'string' || typeof b.verification_url !== 'string') {
    throw new CliError(`cannot start the login: ${describeRefusal(start)}`);
  }
  const deviceCode = b.device_code;
  let intervalMs = (typeof b.interval === 'number' && b.interval > 0 ? b.interval : 5) * 1000;
  const deadline = now() + (typeof b.expires_in === 'number' ? b.expires_in : 600) * 1000;

  io.err(`Open this page on any device and sign in with DFL:\n\n  ${b.verification_url}\n\nCheck that the page shows the code ${b.user_code}, then click Allow.`);
  io.err('Waiting for the approval (the code expires in 10 minutes)…');

  for (;;) {
    await sleep(intervalMs);
    if (now() > deadline) throw new CliError('the code expired before it was approved. Run tma login again.');
    const t = await apiCall(base, '/auth/cli/token', { method: 'POST', body: { device_code: deviceCode }, fetchImpl: deps.fetchImpl });
    const tb = t.body ?? {};
    if (t.status === 428) continue;
    if (t.status === 429 && tb.error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    if (t.status === 200 && typeof tb.sessionToken === 'string' && typeof tb.expiresAt === 'string' && typeof tb.sessionId === 'string') {
      const principal = typeof tb.principal === 'string' ? tb.principal : 'unknown';
      const path = writeSession(
        { format: SESSION_FORMAT, api_url: base, principal, session_id: tb.sessionId, session_token: tb.sessionToken, expires_at: tb.expiresAt },
        env,
      );
      io.out(`Logged in as ${principal}. The session is valid until ${tb.expiresAt}.`);
      io.err(`Saved to ${path} (mode 600). Do not share this file.`);
      return 0;
    }
    if (tb.error === 'access_denied') throw new CliError('the login was denied on the web page.');
    if (tb.error === 'code_expired') throw new CliError('the code expired before it was approved. Run tma login again.');
    throw new CliError(`the login failed: ${describeRefusal(t)}`);
  }
}

export async function logout(argv: string[], io: Io, deps: LoginDeps = {}): Promise<number> {
  const args = parseArgs(argv, {});
  if (args.positionals.length > 0) throw new CliError('usage: tma logout');
  const env = deps.env ?? process.env;
  let s = null;
  try {
    s = loadSessionFile(env);
  } catch {
    s = null; // an unsafe or broken file: delete it anyway
  }
  if (s && Date.parse(s.expires_at) > (deps.now ?? Date.now)()) {
    const r = await apiCall(s.api_url, `/me/cli-sessions/${encodeURIComponent(s.session_id)}`, {
      method: 'DELETE',
      token: s.session_token,
      fetchImpl: deps.fetchImpl,
    }).catch(() => null);
    if (r && r.status !== 204 && r.status !== 401 && r.status !== 404) io.err(`warning: the API did not revoke the session (${describeRefusal(r)})`);
  }
  const removed = deleteSession(env);
  io.out(removed ? 'Logged out. The session is revoked and its file is deleted.' : 'You were not logged in.');
  return 0;
}

export const loginCommand: Command = {
  name: 'login',
  summary: 'Sign in with DFL on a web page; stores a 24 h session (mode 600)',
  usage: LOGIN_USAGE,
  main: (argv, io) => login(argv, io),
};

export const logoutCommand: Command = {
  name: 'logout',
  summary: 'Revoke the CLI session and delete its file',
  usage: 'usage: tma logout',
  main: (argv, io) => logout(argv, io),
};

