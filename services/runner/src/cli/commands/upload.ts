// `tma upload <file> [--dry-run]` (plan 20261026-tma-local-runner-and-self-declared-results, §1, §4
// step 2, ADR-1, ADR-2; task L7). Sends the NUMBERS of a local run to POST /self-declared-results, the
// one door for a result that TMA did not run. The result is self-declared: TMA does not attest it.
//
// - `<file>` is a tma-local-result/1 file (`tma run`, `tma grade`, or a third-party harness), or an old
//   `tma-bench-import/*` file (one body per executor, with --agent).
// - Every body is validated locally with the contract (packages/contracts) BEFORE any network call: an
//   unknown key (actions, patch, stdout, a prompt, a key) is refused here, with its JSON path.
// - Every string of every body is scanned for a credential (an `sk-` key, a bearer token, a JWT, the
//   session token). A match stops the upload; the CLI never sends logs (plan §0 point 5).
// - `--dry-run` prints the exact bodies, then asks the API with ?dry_run=1 (every check, then a
//   rollback) when you are logged in. Nothing is written.
import { readFileSync, statSync } from 'node:fs';
import { parseLocalResultText, validateLocalResult, type LocalResult } from '@itera/contracts';
import { apiCall, describeRefusal, type Fetch } from '../api.js';
import { flag, has, numberFlag, parseArgs } from '../args.js';
import type { Command, Io } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { isLegacyFormat, legacyToLocalResults } from '../legacy.js';
import { loadSessionFile, requireSession } from '../session.js';

export interface UploadDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  now?: () => number;
}

const USAGE =
  'usage: tma upload <result.json> [--dry-run] [--agent <agent id>]\n' +
  '       tma upload <old tma-bench-import file> --agent <agent id> [--executor <model id>] [--task-version <n>] [--dry-run]';

/** An old import file can hold many executors; each body that goes to the API is at most 1 MiB. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Patterns of a credential in a string value. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{6,}/, 'an API key (sk-...)'],
  [/\bbearer\s/i, 'a bearer header'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'a JWT'],
  [/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{10,}/, 'a GitHub token'],
];

/** The JSON paths of the strings that look like a credential (or hold `token`). Empty = clean. */
export function findSecrets(value: unknown, token?: string, path = ''): string[] {
  if (typeof value === 'string') {
    const hits: string[] = [];
    if (token && token.length >= 16 && value.includes(token)) hits.push(`${path || '/'} holds the session token`);
    for (const [re, what] of SECRET_PATTERNS) if (re.test(value)) hits.push(`${path || '/'} looks like ${what}`);
    return hits;
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, token, `${path}/${i}`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [...findSecrets(k, token, `${path}/${k}`), ...findSecrets(v, token, `${path}/${k}`)]);
  return [];
}

export interface PreparedBody {
  label: string;
  body: LocalResult;
}

/** Reads, converts and validates the file. Throws CliError before any network call on any problem. */
export function prepareUpload(file: string, opts: { agentId?: string; executor?: string; taskVersion?: number; token?: string }): PreparedBody[] {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw new CliError(`cannot read ${file}`);
  }
  if (size > MAX_FILE_BYTES) throw new CliError(`${file} is ${size} bytes; the limit is ${MAX_FILE_BYTES}`);
  const text = readFileSync(file, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(`${file} is not JSON`);
  }
  if (opts.agentId !== undefined && !UUID_RE.test(opts.agentId)) throw new CliError('--agent must be an agent id (a uuid): see tma agent create');

  let bodies: PreparedBody[];
  if (raw && typeof raw === 'object' && isLegacyFormat((raw as { format?: unknown }).format)) {
    if (!opts.agentId) throw new CliError('an old tma-bench-import file needs --agent <agent id> (see tma agent create)');
    bodies = legacyToLocalResults(raw, { agentId: opts.agentId, executor: opts.executor, taskVersion: opts.taskVersion }).map((b) => ({ label: b.executor, body: b.body }));
  } else {
    if (opts.executor !== undefined || opts.taskVersion !== undefined) throw new CliError('--executor and --task-version are only for an old tma-bench-import file');
    const checked = parseLocalResultText(text);
    if (!checked.ok) throw new CliError(`${file} is not a valid tma-local-result/1 file:\n  ${checked.errors.slice(0, 10).join('\n  ')}`);
    const body = opts.agentId ? { ...checked.value, agent_id: opts.agentId } : checked.value;
    bodies = [{ label: body.executor.model_id, body }];
  }

  for (const b of bodies) {
    const checked = validateLocalResult(b.body);
    if (!checked.ok) throw new CliError(`${b.label}: the result is not valid tma-local-result/1:\n  ${checked.errors.slice(0, 10).join('\n  ')}`);
    const bytes = Buffer.byteLength(JSON.stringify(b.body), 'utf8');
    if (bytes > 1024 * 1024) throw new CliError(`${b.label}: the body is ${bytes} bytes; the API takes at most 1 MiB`);
    const secrets = findSecrets(b.body, opts.token);
    if (secrets.length > 0) throw new CliError(`${b.label}: the upload stops, a value looks like a credential:\n  ${secrets.slice(0, 5).join('\n  ')}`);
  }
  return bodies;
}

export async function upload(argv: string[], io: Io, deps: UploadDeps = {}): Promise<number> {
  const a = parseArgs(argv, { 'dry-run': { boolean: true }, agent: {}, executor: {}, 'task-version': {} });
  if (a.positionals.length !== 1) throw new CliError(USAGE);
  const env = deps.env ?? process.env;
  const base = apiUrl(env);
  const now = (deps.now ?? Date.now)();
  const dryRun = has(a, 'dry-run');

  // A dry run works without a login (it then only checks locally); a real upload needs one.
  let token: string | undefined;
  if (dryRun) {
    const s = loadSessionFile(env);
    token = s && s.api_url === base && Date.parse(s.expires_at) > now ? s.session_token : undefined;
  } else {
    token = requireSession(base, now, env).session_token;
  }

  const bodies = prepareUpload(a.positionals[0]!, {
    agentId: flag(a, 'agent'),
    executor: flag(a, 'executor'),
    taskVersion: numberFlag(a, 'task-version', { min: 1, max: 999_999, integer: true }),
    token,
  });

  if (dryRun) {
    io.err(`dry run: ${bodies.length} result(s). This is exactly what tma upload sends:`);
    io.out(JSON.stringify(bodies.length === 1 ? bodies[0]!.body : bodies.map((b) => b.body), null, 2));
    if (!token) {
      io.err('You are not logged in, so the API checks are skipped. Run tma login, then tma upload --dry-run again.');
      return 0;
    }
  }

  let failed = 0;
  for (const b of bodies) {
    const r = await apiCall(base, `/self-declared-results${dryRun ? '?dry_run=1' : ''}`, { method: 'POST', body: b.body, token, fetchImpl: deps.fetchImpl });
    const rb = r.body ?? {};
    if ((r.status === 200 || r.status === 201) && typeof rb.evaluation_id === 'string') {
      const verb = dryRun ? `dry run OK, it would be ${String(rb.action)}` : String(rb.action);
      io.out(`${b.label}: ${verb}. Evaluation ${rb.evaluation_id} (self-declared)${dryRun ? '' : ` ${String(rb.url ?? '')}`}`.trimEnd());
    } else {
      failed++;
      io.err(`${b.label}: refused: ${describeRefusal(r)}`);
      if (r.status === 401) break;
    }
  }
  return failed === 0 ? 0 : 1;
}

export const uploadCommand: Command = {
  name: 'upload',
  summary: 'Send the numbers of a local result to TestMyAgent (self-declared); --dry-run shows the body',
  usage: USAGE,
  main: (argv, io) => upload(argv, io),
};
