import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTask, materializeWorkspace, scenarioDir } from '../../evaluator/src/task.js';
import { BUNDLE_FOLDER } from '../../evaluator/src/pack-folders.js';
import { exec } from './exec.js';
import { loadRunProfile } from './run-profile.js';

/** Agent files that are copied from the agent directory into the workspace. Nothing else is. */
export const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
/** The agent's `skills/` directory goes where opencode discovers project skills. */
export const SKILLS_TARGET = join('.opencode', 'skills');

/**
 * Git flags for every git call on a tree that an agent touched. The repository config and
 * hooks stay ours: a planted hook, fsmonitor or filter in the agent tree cannot run on the worker.
 */
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=true'];
const GIT_ID = ['-c', 'user.email=runner@itera.local', '-c', 'user.name=itera-runner'];

async function git(args: string[], cwd: string): Promise<string> {
  const result = await exec('git', [...SAFE_GIT, ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.slice(0, 400)}`);
  return result.stdout;
}

export interface PreparedWorkspace {
  /** Root of the per-run temp dir. Remove it with cleanup(). */
  root: string;
  /** The workspace that is copied into the sandbox: fixture + agent files + node_modules + .git baseline. */
  dir: string;
  /** Which agent files were found and copied (relative paths). */
  agentFiles: string[];
  cleanup: () => Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

/**
 * Build the workspace for one run: ONLY the scenario fixture (no monorepo, no evaluator, no
 * hidden tests), plus the agent's AGENTS.md / CLAUDE.md / skills/. Dependencies are installed
 * here, on the trusted side with network, so the agent can run the public tests offline.
 * A baseline commit makes `git diff` show only what the agent changed.
 */
export async function prepareWorkspace(opts: {
  repoRoot: string;
  scenarioId: string;
  /** A task bundle outside benchmarks/ (user task). Default: benchmarks/<scenarioId>. */
  taskDir?: string;
  agentDir: string;
  installDeps?: boolean;
  /** The run profile's install_cmd (argv). Default: the built-in opencode profile. */
  installCmd?: string[];
}): Promise<PreparedWorkspace> {
  if (!opts.taskDir && !BUNDLE_FOLDER.test(opts.scenarioId)) throw new Error(`invalid scenario id: ${opts.scenarioId}`);
  const taskDir = opts.taskDir ?? scenarioDir(opts.repoRoot, opts.scenarioId);
  if (!(await exists(join(taskDir, 'task.json')))) throw new Error(`no task bundle for scenario ${opts.scenarioId}`);
  const task = await loadTask(taskDir);

  const root = await mkdtemp(join(tmpdir(), 'itera-run-'));
  const dir = join(root, 'workspace');
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    // environment/ + public tests only: never tests/hidden, never solution/.
    await materializeWorkspace(task, dir);

    const agentFiles: string[] = [];
    for (const name of AGENT_FILES) {
      const src = join(opts.agentDir, name);
      if (await exists(src)) {
        await cp(src, join(dir, name), { dereference: false });
        agentFiles.push(name);
      }
    }
    const skills = join(opts.agentDir, 'skills');
    if (await exists(skills)) {
      await mkdir(join(dir, '.opencode'), { recursive: true });
      await cp(skills, join(dir, SKILLS_TARGET), { recursive: true, dereference: false, verbatimSymlinks: true });
      for (const entry of await readdir(join(dir, SKILLS_TARGET))) agentFiles.push(`skills/${entry}`);
    }

    if (opts.installDeps !== false) {
      const profile = loadRunProfile();
      const installCmd = opts.installCmd ?? profile.install_cmd;
      const install = await exec(installCmd[0]!, installCmd.slice(1), {
        cwd: dir,
        timeoutMs: profile.timeouts.install_sec * 1000,
        // No worker variable reaches npm: a .npmrc can expand ${VAR} into a registry request.
        env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8' },
      });
      if (install.code !== 0) throw new Error(`install (${installCmd.slice(0, 2).join(' ')}) failed: ${install.stderr.slice(0, 400)}`);
    }

    await commitBaseline(dir);
    return { root, dir, agentFiles, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** The baseline `.gitignore` of a workspace: node_modules never enters the diff. */
export const BASELINE_GITIGNORE = 'node_modules/\n';

/**
 * Write the baseline `.gitignore` and commit the tree as `baseline` in a NEW repository in `dir`.
 * `diffAgainstBaseline(dir, tree)` then shows only what changed in `tree`. The local runner
 * (src/cli) passes its own ignore text, so its `.tma/` metadata folder never enters a patch.
 */
export async function commitBaseline(dir: string, gitignore: string = BASELINE_GITIGNORE): Promise<void> {
  await writeFile(join(dir, '.gitignore'), gitignore, 'utf-8');
  await git(['init', '-q'], dir);
  await git(['add', '-A'], dir);
  await git([...GIT_ID, 'commit', '-q', '-m', 'baseline'], dir);
}

/**
 * Diff the tree the agent returned against OUR baseline repository. The agent's own `.git`
 * is never used (it was dropped on extraction): its config could run commands on the worker.
 * Returns a unified diff with paths relative to the fixture root, or '' when nothing changed.
 */
export async function diffAgainstBaseline(baselineDir: string, agentTree: string): Promise<string> {
  const gitDir = join(baselineDir, '.git');
  const base = [`--git-dir=${gitDir}`, `--work-tree=${agentTree}`];
  // The baseline .gitignore keeps node_modules out even if the agent rewrote its own copy.
  await git([...base, '-c', `core.excludesFile=${join(baselineDir, '.gitignore')}`, 'add', '-A'], baselineDir);
  return git([...base, 'diff', '--cached', '--no-color', '--no-ext-diff', '--binary', '--', '.', ':(exclude)node_modules'], baselineDir);
}

export interface ChangedFile {
  /** A = added, M = modified (a deletion is not a stored output). */
  status: 'A' | 'M';
  /** Relative to the fixture root. */
  path: string;
}

/**
 * The files the agent ADDED or MODIFIED, against the same baseline index that `diffAgainstBaseline`
 * uses (L17a: the stored `files/<path>` artifacts). Same git flags and the same node_modules exclusion;
 * no rename detection, so a moved file is an A. Paths come back NUL-separated, never quoted.
 */
export async function changedAgainstBaseline(baselineDir: string, agentTree: string): Promise<ChangedFile[]> {
  const gitDir = join(baselineDir, '.git');
  const base = [`--git-dir=${gitDir}`, `--work-tree=${agentTree}`];
  await git([...base, '-c', `core.excludesFile=${join(baselineDir, '.gitignore')}`, 'add', '-A'], baselineDir);
  const out = await git([...base, 'diff', '--cached', '--name-status', '--no-renames', '--diff-filter=AM', '-z', '--', '.', ':(exclude)node_modules'], baselineDir);
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const path = parts[i + 1]!;
    if ((status === 'A' || status === 'M') && path.length > 0) files.push({ status, path });
  }
  return files;
}
