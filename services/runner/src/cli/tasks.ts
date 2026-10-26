// Which task a local command uses, and how the result names it (plan §4 "Public task vs private folder").
//
// - A curated task (`--task <slug>`): a bundle under benchmarks/ (in the repo, and in the runner image).
//   The result names it by the bundle folder (the catalog slug) and the integer version of its task.json.
// - A private folder (`--task-dir <dir>`): any task bundle on the user's disk. It never leaves the
//   machine. The result carries only its digests and a short name (`task.local`).
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { LocalResult } from '@itera/contracts';
import { loadTask, taskDigests, TaskError, type LoadedTask } from '../../../evaluator/src/task.js';
import { flag, flagList, type ParsedArgs } from './args.js';
import { CliError } from './env.js';

/** The repository root (in the runner image: /app). The CLI lives at services/runner/src/cli/. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
export const BENCHMARKS_DIR = join(REPO_ROOT, 'benchmarks');

const BUNDLE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LOCAL_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_TEXT = /[^A-Za-z0-9 .,:;/()+\-_%$=&'#]/g;

export type TaskRef = LocalResult['task'];

export interface ResolvedTask {
  /** The bundle directory (absolute). */
  dir: string;
  task: LoadedTask;
  /** A short id for run names and messages (the bundle folder name). */
  id: string;
  /** sha256 of the bundle's environment/: the `item_sha256` of each result row. */
  itemSha256: string;
  digests: Awaited<ReturnType<typeof taskDigests>>;
}

export interface LocalBundle {
  name: string;
  version: string;
  title: string;
  hasMcp: boolean;
}

/** The task flags that every command with a task shares. */
export const TASK_FLAGS = { task: {}, 'task-dir': { repeat: true }, slug: {} } as const;

const hasMcp = (task: LoadedTask) => (task.contract.environment.tools?.mcp ?? []).length > 0;

/** The curated bundles that this checkout (or image) holds, sorted by name. Works offline. */
export async function localBundles(dir = BENCHMARKS_DIR): Promise<LocalBundle[]> {
  const out: LocalBundle[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !BUNDLE_NAME.test(entry.name)) continue;
    const task = await loadTask(join(dir, entry.name)).catch(() => null);
    if (!task) continue;
    out.push({
      name: entry.name,
      version: task.contract.task.version,
      title: task.contract.metadata?.title ?? task.contract.task.description ?? entry.name,
      hasMcp: hasMcp(task),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load a task bundle. A bundle that does not pass the task contract is a user error, not a crash. */
export async function loadResolved(dir: string): Promise<ResolvedTask> {
  try {
    const task = await loadTask(dir);
    const digests = await taskDigests(task);
    return { dir: task.dir, task, id: basename(task.dir).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'task', itemSha256: digests.environment, digests };
  } catch (err) {
    if (err instanceof TaskError) throw new CliError(`task folder ${dir}: ${err.message}`);
    throw err;
  }
}

/** The catalog version of a curated task: the integer (or the major number) of its task.json version. */
export function catalogVersion(task: LoadedTask): number {
  const n = Number.parseInt(task.contract.task.version, 10);
  if (!Number.isInteger(n) || n < 1 || n > 999_999) {
    throw new CliError(`task ${task.contract.task.name} has version ${task.contract.task.version}: a curated task needs a version that starts with an integer from 1`);
  }
  return n;
}

/** A private task's reference: its slug, a short name, and the three digests. Nothing else leaves. */
export function localTaskRef(items: ResolvedTask[], slugFlag?: string): TaskRef {
  if (items.length === 0) throw new CliError('no task folder');
  const first = items[0]!.task;
  const fromName = (first.contract.task.name.split('/').pop() ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = (slugFlag ?? fromName).slice(0, 63);
  if (!LOCAL_SLUG.test(slug)) throw new CliError(`the task slug must be lowercase letters, digits and dashes (got ${slug.slice(0, 80) || 'nothing'}): pass --slug`);
  if (items.length > 1 && !slugFlag) throw new CliError('several --task-dir folders form ONE private task: name it with --slug');
  const clean = (s: string, max: number) => s.replace(SAFE_TEXT, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  const name = clean(items.length > 1 ? `${slug} (${items.length} items)` : (first.contract.metadata?.title ?? first.contract.task.name), 60) || slug;
  const description = clean(first.contract.task.description ?? '', 120);
  // One folder: its own digests. Several folders (variants of one task): the digest of the sorted item digests.
  const combine = (pick: (r: ResolvedTask) => string) => (items.length === 1 ? pick(items[0]!) : createHash('sha256').update(items.map(pick).sort().join('\n')).digest('hex'));
  return {
    local: {
      slug,
      name,
      ...(description ? { description } : {}),
      contract_sha256: combine((r) => r.digests.contract),
      environment_sha256: combine((r) => r.digests.environment),
      hidden_tests_sha256: combine((r) => r.digests.hidden_tests),
    },
  };
}

export interface TaskSelection {
  items: ResolvedTask[];
  /** How the result names the task. */
  ref: TaskRef;
}

/** Read `--task` / `--task-dir` / `--slug` of a command. Exactly one of `--task` and `--task-dir`. */
export async function selectTasks(a: ParsedArgs, opts: { benchmarksDir?: string } = {}): Promise<TaskSelection> {
  const name = flag(a, 'task');
  const dirs = flagList(a, 'task-dir');
  if ((name === undefined) === (dirs.length === 0)) throw new CliError('give the task: --task <slug> (a curated task, see "tma tasks") or --task-dir <folder> (a private task)');
  if (name !== undefined) {
    if (flag(a, 'slug') !== undefined) throw new CliError('--slug is only for --task-dir');
    const benchmarks = opts.benchmarksDir ?? BENCHMARKS_DIR;
    if (!BUNDLE_NAME.test(name) || !(await stat(join(benchmarks, name, 'task.json')).catch(() => null))) {
      throw new CliError(`no curated task "${name.slice(0, 60)}" in this runner: see "tma tasks". For a private folder use --task-dir <folder>.`);
    }
    const resolved = await loadResolved(join(benchmarks, name));
    return { items: [resolved], ref: { catalog: { slug: name, version: catalogVersion(resolved.task) } } };
  }
  const items: ResolvedTask[] = [];
  for (const dir of dirs) {
    if (!(await stat(join(dir, 'task.json')).catch(() => null))) throw new CliError(`no task.json in ${dir}`);
    items.push(await loadResolved(dir));
  }
  return { items, ref: localTaskRef(items, flag(a, 'slug')) };
}

/** MCP tasks need the TMA MCP sidecars: hosted only in v1 (a curated task or a private folder). */
export function refuseMcp(r: ResolvedTask): void {
  if (hasMcp(r.task)) throw new CliError(`task ${r.id} uses MCP servers: the local runner (v1) does not run MCP tasks. Run it hosted on TestMyAgent.`);
}
