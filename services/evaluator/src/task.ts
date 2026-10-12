// Load a task bundle (task.json + instruction.md + environment/ + tests/ + solution/) and build
// workspaces from it. The contract is schemas/task.schema.json in packages/contracts.
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { validateTaskContract, type TaskContract } from '@itera/contracts';
import { matchesAny } from './glob.js';
import type { ScopeRules } from './patch-scope.js';

export type { TaskContract };

export class TaskError extends Error {}

/** npm registries whose tarballs a task lockfile may resolve to. Anything else is refused. */
export const ALLOWED_REGISTRY_PREFIXES = ['https://registry.npmjs.org/'];

export interface LoadedTask {
  /** Absolute path of the bundle root (the directory that holds task.json). */
  dir: string;
  contract: TaskContract;
  /** sha256 hex of the task.json bytes. */
  contractDigest: string;
  paths: {
    instruction: string;
    environment: string;
    publicTests: string;
    hiddenTests: string;
    solution: string;
  };
  scope: ScopeRules;
}

function inside(root: string, rel: string): string {
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) throw new TaskError(`path escapes the task bundle: ${rel}`);
  return abs;
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

/** Every regular file under dir (sorted, POSIX relative paths). Refuses symlinks and special files. */
export async function listFiles(dir: string, skip: (name: string) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (skip(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new TaskError(`symbolic links are not allowed in a task bundle: ${relative(dir, full)}`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join('/'));
      else throw new TaskError(`unsupported file type in a task bundle: ${relative(dir, full)}`);
    }
  }
  await walk(dir);
  return out.sort();
}

const FORBIDDEN_FILES = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'bunfig.toml']);
const SKIP_GENERATED = (name: string) => name === 'node_modules' || name === '.git' || name === 'dist';

/** sha256 over (relative path, bytes) of every file. Same algorithm as the evaluator's fixture_hash. */
export async function hashDirectory(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await listFiles(dir, SKIP_GENERATED)) {
    hash.update(file);
    hash.update(await readFile(join(dir, file)));
  }
  return hash.digest('hex');
}

/** Refuse a lockfile that resolves a package outside the allowed registries (git, file, http URLs). */
export async function checkLockfile(environmentDir: string): Promise<void> {
  const lockPath = join(environmentDir, 'package-lock.json');
  if (!(await exists(join(environmentDir, 'package.json')))) return;
  if (!(await exists(lockPath))) throw new TaskError('environment/package.json needs a package-lock.json (grading installs with npm ci)');
  let lock: { packages?: Record<string, { resolved?: unknown; link?: unknown }> };
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf-8'));
  } catch {
    throw new TaskError('environment/package-lock.json is not valid JSON');
  }
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (name === '') continue;
    if (entry.link) throw new TaskError(`package-lock.json links a local package (${name}); not allowed`);
    if (typeof entry.resolved === 'string' && !ALLOWED_REGISTRY_PREFIXES.some((p) => (entry.resolved as string).startsWith(p))) {
      throw new TaskError(`package-lock.json resolves ${name} outside the npm registry`);
    }
  }
}

/**
 * Read and check a task bundle: schema (Ajv), paths inside the bundle, required entries present,
 * no symbolic link anywhere, the hidden tests covered by protected_paths, a lockfile on the registry.
 */
export async function loadTask(taskDir: string): Promise<LoadedTask> {
  const dir = resolve(taskDir);
  const raw = await readFile(join(dir, 'task.json')).catch(() => null);
  if (!raw) throw new TaskError(`no task.json in ${taskDir}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf-8'));
  } catch {
    throw new TaskError('task.json is not valid JSON');
  }
  const checked = validateTaskContract(parsed);
  if (!checked.ok) throw new TaskError(`task.json does not match the task schema: ${checked.errors.join('; ')}`);
  const contract = checked.value;

  const paths = {
    instruction: inside(dir, contract.instruction),
    environment: inside(dir, contract.environment.dir),
    publicTests: inside(dir, contract.tests.public),
    hiddenTests: inside(dir, contract.tests.hidden),
    solution: inside(dir, contract.solution.patch),
  };
  for (const [key, path] of Object.entries(paths)) {
    if (!(await exists(path))) throw new TaskError(`task.json names ${key} at ${relative(dir, path)}, which does not exist`);
  }
  // Walk the whole bundle once: refuses symlinks and special files everywhere, and package-manager
  // config files (a .npmrc can point npm at another registry and expand variables into requests).
  for (const file of await listFiles(dir, SKIP_GENERATED)) {
    const base = file.split('/').pop()!;
    if (FORBIDDEN_FILES.has(base)) throw new TaskError(`${file} is not allowed in a task bundle`);
  }

  const scope: ScopeRules = { editable: contract.editable_paths, protected: contract.protected_paths };
  for (const testsDir of [contract.tests.public, contract.tests.hidden]) {
    const probe = `${testsDir}/probe.test.ts`;
    if (!matchesAny(probe, scope.protected)) {
      throw new TaskError(`protected_paths must cover ${testsDir}/ (a patch could otherwise rewrite the tests)`);
    }
  }
  if (contract.tests.public === contract.tests.hidden) throw new TaskError('tests.public and tests.hidden must differ');
  await checkLockfile(paths.environment);

  return {
    dir,
    contract,
    contractDigest: createHash('sha256').update(raw).digest('hex'),
    paths,
    scope,
  };
}

/** Resolve the legacy `--scenario <id>` to its bundle directory under benchmarks/. */
export function scenarioDir(repoRoot: string, scenarioId: string): string {
  if (!/^[a-z0-9-]+$/.test(scenarioId)) throw new TaskError(`invalid scenario id: ${scenarioId}`);
  return join(repoRoot, 'benchmarks', scenarioId);
}

export async function readInstruction(task: LoadedTask): Promise<string> {
  const text = (await readFile(task.paths.instruction, 'utf-8')).trim();
  if (!text) throw new TaskError('the instruction file is empty');
  return text;
}

/**
 * Copy the agent-visible part of the task into `dest`: environment/ at the root, plus the public
 * tests at their declared relative path. With `hidden: true` the hidden tests are added too —
 * only ever for a grading workspace, after the patch is frozen.
 */
export async function materializeWorkspace(task: LoadedTask, dest: string, opts: { hidden?: boolean } = {}): Promise<void> {
  await mkdir(dest, { recursive: true });
  await cp(task.paths.environment, dest, { recursive: true, filter: (src) => !src.split(sep).includes('node_modules') });
  await addTests(task, dest, 'public');
  if (opts.hidden) await addTests(task, dest, 'hidden');
}

export async function addTests(task: LoadedTask, workspace: string, which: 'public' | 'hidden'): Promise<void> {
  const rel = which === 'public' ? task.contract.tests.public : task.contract.tests.hidden;
  const src = which === 'public' ? task.paths.publicTests : task.paths.hiddenTests;
  const dst = inside(workspace, rel);
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true, force: true });
}

/** Digests of each part of the bundle, for the manifest and the validation gate. */
export async function taskDigests(task: LoadedTask): Promise<Record<'contract' | 'environment' | 'public_tests' | 'hidden_tests' | 'solution', string>> {
  return {
    contract: task.contractDigest,
    environment: await hashDirectory(task.paths.environment),
    public_tests: await hashDirectory(task.paths.publicTests),
    hidden_tests: await hashDirectory(task.paths.hiddenTests),
    solution: createHash('sha256').update(await readFile(task.paths.solution)).digest('hex'),
  };
}
