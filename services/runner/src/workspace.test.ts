import { mkdtemp, readdir, rm, writeFile, mkdir, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffAgainstBaseline, prepareWorkspace } from './workspace.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Copy filter that drops `<dir>/.git` (the agent's repository) but keeps `.gitignore`. */
const notGitDir = (dir: string) => (src: string) => src !== join(dir, '.git') && !src.startsWith(`${join(dir, '.git')}/`);

async function agentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'itera-agent-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'AGENTS.md'), '# agent\n');
  await writeFile(join(dir, 'secret.env'), 'NOT_COPIED=1\n');
  await mkdir(join(dir, 'skills', 'loop'), { recursive: true });
  await writeFile(join(dir, 'skills', 'loop', 'SKILL.md'), '---\nname: loop\n---\n');
  return dir;
}

describe('prepareWorkspace', () => {
  it('holds only the fixture plus the agent files, and no evaluator or hidden tests', async () => {
    // 'webhook-ledger' is the OLD pack id (still in production rows): scenarioDir maps it to benchmarks/tsk_webhook_dup.
    const ws = await prepareWorkspace({ repoRoot, scenarioId: 'webhook-ledger', agentDir: await agentDir(), installDeps: false });
    cleanups.push(ws.cleanup);
    const entries = (await readdir(ws.dir)).sort();
    expect(entries).toEqual(['.git', '.gitignore', '.opencode', 'AGENTS.md', 'package-lock.json', 'package.json', 'src', 'tests', 'tsconfig.json', 'vitest.config.ts']);
    expect(ws.agentFiles).toEqual(['AGENTS.md', 'skills/loop']);
    expect(await readdir(join(ws.dir, '.opencode', 'skills', 'loop'))).toEqual(['SKILL.md']);
  });

  it('refuses a scenario id that is not a plain slug', async () => {
    await expect(prepareWorkspace({ repoRoot, scenarioId: '../x', agentDir: '/nonexistent', installDeps: false })).rejects.toThrow(/invalid scenario/);
  });
});

describe('diffAgainstBaseline', () => {
  it('returns only the agent change, relative to the fixture root, and ignores the agent .git', async () => {
    const ws = await prepareWorkspace({ repoRoot, scenarioId: 'webhook-ledger', agentDir: await agentDir(), installDeps: false });
    cleanups.push(ws.cleanup);
    const out = join(ws.root, 'out');
    await cp(ws.dir, out, { recursive: true, filter: notGitDir(ws.dir) });
    const app = join(out, 'src', 'app.ts');
    await writeFile(app, `${await readFile(app, 'utf-8')}\n// agent change\n`);
    await writeFile(join(out, 'src', 'new.ts'), 'export const x = 1;\n');

    const patch = await diffAgainstBaseline(ws.dir, out);
    expect(patch).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(patch).toContain('+// agent change');
    expect(patch).toContain('diff --git a/src/new.ts b/src/new.ts');
    expect(patch).not.toContain('AGENTS.md');
  });

  it('returns an empty patch when nothing changed', async () => {
    const ws = await prepareWorkspace({ repoRoot, scenarioId: 'webhook-ledger', agentDir: await agentDir(), installDeps: false });
    cleanups.push(ws.cleanup);
    const out = join(ws.root, 'out');
    await cp(ws.dir, out, { recursive: true, filter: notGitDir(ws.dir) });
    expect(await diffAgainstBaseline(ws.dir, out)).toBe('');
  });
});
