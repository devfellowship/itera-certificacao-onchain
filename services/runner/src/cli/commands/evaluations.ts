// `tma evaluations delete <id> [--yes]` (plan 20261026-tma-local-runner-and-self-declared-results, task L19,
// Q 87769da2 = C). Deletes ONE self-declared evaluation of the logged-in user, with its runs, through
// DELETE /evaluations/:id. The API checks the owner and refuses a hosted evaluation (409).
//
// It reads the evaluation first (GET /evaluations/:id) and shows it, then asks "y/N" on the terminal.
// `--yes` skips the question. Without a terminal and without `--yes` it refuses: a script must say --yes.
import { createInterface } from 'node:readline/promises';
import { apiCall, describeRefusal, type Fetch } from '../api.js';
import { has, parseArgs } from '../args.js';
import type { Command, Io } from '../command.js';
import { apiUrl, CliError } from '../env.js';
import { requireSession } from '../session.js';

export interface EvaluationsDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  now?: () => number;
  /** Asks the question on the terminal; true = delete. Null when there is no terminal. */
  confirm?: ((question: string) => Promise<boolean>) | null;
}

const USAGE = 'usage: tma evaluations delete <evaluation id> [--yes]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function terminalConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const defaultConfirm = () => (process.stdin.isTTY ? terminalConfirm : null);

/** One line about the evaluation, from the GET /evaluations/:id view. Only names and numbers. */
export function describeEvaluation(id: string, v: Record<string, unknown> | null): string {
  const agent = (v?.agent as { name?: unknown } | undefined)?.name;
  const model = (v?.model as { id?: unknown } | undefined)?.id;
  const tasks = Array.isArray(v?.tasks) ? (v!.tasks as Array<{ slug?: unknown; name?: unknown }>).map((t) => String(t.slug ?? t.name ?? '?')).join(', ') : '';
  const score = typeof v?.score === 'number' ? ` score ${v.score}` : '';
  const origin = typeof v?.resultOrigin === 'string' ? ` (${v.resultOrigin})` : '';
  return `evaluation ${id}: agent "${String(agent ?? '?')}", model ${String(model ?? '?')}, task ${tasks || '?'}${score}${origin}`;
}

export async function evaluations(argv: string[], io: Io, deps: EvaluationsDeps = {}): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'delete') throw new CliError(USAGE);
  const a = parseArgs(rest, { yes: { boolean: true } });
  if (a.positionals.length !== 1) throw new CliError(USAGE);
  const id = a.positionals[0]!;
  if (!UUID_RE.test(id)) throw new CliError(`not an evaluation id: ${id.slice(0, 60)}\n${USAGE}`);

  const env = deps.env ?? process.env;
  const base = apiUrl(env);
  const s = requireSession(base, (deps.now ?? Date.now)(), env);
  const call = (method: 'GET' | 'DELETE') => apiCall(base, `/evaluations/${id}`, { method, token: s.session_token, fetchImpl: deps.fetchImpl });

  const view = await call('GET');
  if (view.status === 404) throw new CliError(`evaluation ${id} not found (or it is not yours)`);
  if (view.status !== 200) throw new CliError(`cannot read the evaluation: ${describeRefusal(view)}`);
  const line = describeEvaluation(id, view.body);
  if (view.body?.resultOrigin !== 'self_declared') {
    throw new CliError(`${line}\nonly a self-declared evaluation can be deleted`);
  }

  if (!has(a, 'yes')) {
    const confirm = deps.confirm === undefined ? defaultConfirm() : deps.confirm;
    if (!confirm) throw new CliError(`${line}\nno terminal to confirm: run again with --yes to delete it`);
    io.err(line);
    if (!(await confirm('Delete this evaluation and its runs? This cannot be undone. [y/N] '))) {
      io.err('Not deleted.');
      return 1;
    }
  }

  const r = await call('DELETE');
  if (r.status === 404) throw new CliError(`evaluation ${id} not found (or it is not yours)`);
  if (r.status !== 200 || r.body?.deleted !== true) throw new CliError(`cannot delete the evaluation: ${describeRefusal(r)}`);
  io.err(`Deleted ${line} (${String(r.body.deletedRuns ?? '?')} run(s)).`);
  io.out(id);
  return 0;
}

export const evaluationsCommand: Command = {
  name: 'evaluations',
  summary: 'Delete one of your self-declared evaluations (asks first; --yes skips the question)',
  usage: USAGE,
  main: (argv, io) => evaluations(argv, io),
};
