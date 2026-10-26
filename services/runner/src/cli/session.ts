// The login session of the `tma` CLI (plan 20261026-tma-local-runner-and-self-declared-results, §4,
// ADR-7; task L7). `tma login` stores a 24 h TMA session in <config dir>/session.json, mode 600, in a
// directory of mode 700. The config dir is TMA_CONFIG_DIR, else ~/.config/tma.
//
// The token is a bearer credential: this module never prints it, and `readSession` refuses a file that
// another user can read (as ssh does with a private key).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, userEnv } from './env.js';

export const SESSION_FORMAT = 'tma-cli-session/1';

export interface CliSessionFile {
  format: typeof SESSION_FORMAT;
  /** The API that issued the session. A session is used only against this API. */
  api_url: string;
  /** The principal, `dfl:<uuid>`. */
  principal: string;
  /** The `cli_device_codes.session_id` (the `sid` claim): `tma logout` revokes it. */
  session_id: string;
  session_token: string;
  expires_at: string;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return userEnv('TMA_CONFIG_DIR', env) ?? join(homedir(), '.config', 'tma');
}

export function sessionPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'session.json');
}

const POSIX = process.platform !== 'win32';

/** Writes the session file: the directory 700, the file 600 from its first byte (temp file + rename). */
export function writeSession(s: CliSessionFile, env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX) chmodSync(dir, 0o700);
  const path = join(dir, 'session.json');
  const tmp = join(dir, `.session.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  if (POSIX) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

export function deleteSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = sessionPath(env);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The stored session, or null when there is none. Throws CliError on a file that is not safe or not valid. */
export function loadSessionFile(env: NodeJS.ProcessEnv = process.env): CliSessionFile | null {
  const path = sessionPath(env);
  if (!existsSync(path)) return null;
  if (POSIX && (statSync(path).mode & 0o077) !== 0) {
    throw new CliError(`${path} can be read by other users. Run: chmod 600 ${path} (or tma login again).`);
  }
  let v: Partial<CliSessionFile>;
  try {
    v = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CliSessionFile>;
  } catch {
    throw new CliError(`${path} is not valid JSON. Run tma login again.`);
  }
  if (v.format !== SESSION_FORMAT || !isStr(v.api_url) || !isStr(v.principal) || !isStr(v.session_id) || !isStr(v.session_token) || !isStr(v.expires_at)) {
    throw new CliError(`${path} is not a tma session file. Run tma login again.`);
  }
  return v as CliSessionFile;
}

/**
 * The session to call `apiUrl` with. Refuses when there is none, when it expired, or when it belongs
 * to another API (a session goes only to the API that issued it).
 */
export function requireSession(apiUrl: string, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): CliSessionFile {
  const s = loadSessionFile(env);
  if (!s) throw new CliError('You are not logged in. Run: tma login');
  if (s.api_url !== apiUrl) throw new CliError(`Your session is for ${s.api_url}, not ${apiUrl}. Run: tma login`);
  const exp = Date.parse(s.expires_at);
  if (!Number.isFinite(exp) || exp <= nowMs) throw new CliError('Your session expired (it lasts 24 h). Run: tma login');
  return s;
}
