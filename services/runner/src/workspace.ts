import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from './exec.js';

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
  agentDir: string;
  installDeps?: boolean;
}): Promise<PreparedWorkspace> {
  if (!/^[a-z0-9-]+$/.test(opts.scenarioId)) throw new Error(`invalid scenario id: ${opts.scenarioId}`);
  const fixture = join(opts.repoRoot, 'benchmarks', opts.scenarioId, 'fixture');
  if (!(await exists(fixture))) throw new Error(`no fixture for scenario ${opts.scenarioId}`);

  const root = await mkdtemp(join(tmpdir(), 'itera-run-'));
  const dir = join(root, 'workspace');
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    await cp(fixture, dir, { recursive: true, filter: (src) => !src.split('/').includes('node_modules') });

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
      const install = await exec('npm', ['ci', '--include=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: dir, timeoutMs: 180_000 });
      if (install.code !== 0) throw new Error(`npm ci failed: ${install.stderr.slice(0, 400)}`);
    }

    await writeFile(join(dir, '.gitignore'), 'node_modules/\n', 'utf-8');
    await git(['init', '-q'], dir);
    await git(['add', '-A'], dir);
    await git([...GIT_ID, 'commit', '-q', '-m', 'baseline'], dir);
    return { root, dir, agentFiles, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
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
