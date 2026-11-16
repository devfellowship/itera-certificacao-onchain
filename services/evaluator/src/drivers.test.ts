// Driver contract of task.json (plan 20261112-dfl-os-eval-cases-from-real-tasks ADR-5): the lockfile
// policy driver and optional public tests. Defaults keep the 0.3.0 behaviour.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EVALUATOR_VERSION, runEvaluation } from './runner.js';
import { checkLockfile, loadTask, taskDigests } from './task.js';
import { validateTask } from './validate.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const ledgerDir = join(repoRoot, 'benchmarks', 'tsk_webhook_dup');
const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** An environment/ with a package.json, one workspace package and a lockfile with the given entries. */
async function workspaceEnv(entries: Record<string, Record<string, unknown>>): Promise<string> {
  const env = await tmp('itera-ws-env-');
  await writeFile(join(env, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
  await mkdir(join(env, 'packages', 'base'), { recursive: true });
  await writeFile(join(env, 'packages', 'base', 'package.json'), JSON.stringify({ name: '@x/base', version: '1.0.0' }));
  await mkdir(join(env, 'packages', 'nopkg'), { recursive: true });
  await writeFile(join(env, 'packages', 'file.txt'), 'not a directory');
  const lock = { name: 'root', lockfileVersion: 3, packages: { '': { name: 'root', workspaces: ['packages/*'] }, 'packages/base': { name: '@x/base', version: '1.0.0' }, ...entries } };
  await writeFile(join(env, 'package-lock.json'), JSON.stringify(lock));
  return env;
}

const link = (resolved: unknown) => ({ 'node_modules/@x/base': { resolved, link: true } });

describe('lockfile policy driver', () => {
  it('registry-only (the default) still refuses every workspace link', async () => {
    const env = await workspaceEnv(link('packages/base'));
    await expect(checkLockfile(env)).rejects.toThrow(/links a local package \(node_modules\/@x\/base\); not allowed/);
    await expect(checkLockfile(env, 'registry-only')).rejects.toThrow(/links a local package/);
  });

  it('workspace-links allows a link that resolves to a package directory inside environment/', async () => {
    const env = await workspaceEnv(link('packages/base'));
    await expect(checkLockfile(env, 'workspace-links')).resolves.toBeUndefined();
    const dotted = await workspaceEnv(link('packages/./base'));
    await expect(checkLockfile(dotted, 'workspace-links')).resolves.toBeUndefined();
  });

  // Mutation proof target: a link that escapes environment/ must stay refused under workspace-links.
  it.each([
    ['../outside', /outside environment/],
    ['packages/../../outside', /outside environment/],
    ['..', /outside environment/],
    ['.', /outside environment/],
    ['/etc', /not relative/],
    ['file:../outside', /not relative/],
    ['https://registry.npmjs.org/x.tgz', /not relative/],
    ['packages\\..\\..\\outside', /not relative/],
    ['packages/missing', /not a directory/],
    ['packages/file.txt', /not a directory/],
    ['packages/nopkg', /without a package.json/],
    ['', /without a resolved path/],
    [undefined, /without a resolved path/],
  ])('workspace-links refuses a link to %j', async (resolved, why) => {
    const env = await workspaceEnv(link(resolved));
    await expect(checkLockfile(env, 'workspace-links')).rejects.toThrow(why);
  });

  it('workspace-links keeps the registry rule for every entry that is not a link', async () => {
    const env = await workspaceEnv({ ...link('packages/base'), 'node_modules/evil': { version: '1.0.0', resolved: 'https://attacker.example/evil.tgz' } });
    await expect(checkLockfile(env, 'workspace-links')).rejects.toThrow(/resolves node_modules\/evil outside the npm registry/);
  });

  it('loadTask reads the policy from task.json environment.lockfile', async () => {
    const dir = await tmp('itera-ws-task-');
    await cp(ledgerDir, dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
    const lockPath = join(dir, 'environment', 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.packages['node_modules/@x/base'] = { resolved: 'src', link: true };
    await writeFile(join(dir, 'environment', 'src', 'package.json'), JSON.stringify({ name: '@x/base' }));
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(loadTask(dir)).rejects.toThrow(/links a local package/);
    const task = JSON.parse(await readFile(join(dir, 'task.json'), 'utf-8'));
    await writeFile(join(dir, 'task.json'), JSON.stringify({ ...task, environment: { ...task.environment, lockfile: 'workspace-links' } }));
    await expect(loadTask(dir)).resolves.toMatchObject({ contract: { environment: { lockfile: 'workspace-links' } } });
    await writeFile(join(dir, 'task.json'), JSON.stringify({ ...task, environment: { ...task.environment, lockfile: 'anything' } }));
    await expect(loadTask(dir)).rejects.toThrow(/does not match the task schema/);
  });
});

/** A copy of tsk_webhook_dup without public tests (tests.public removed from task.json and disk). */
async function noPublicCopy(): Promise<string> {
  const dir = await tmp('itera-nopublic-');
  await cp(ledgerDir, dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
  const task = JSON.parse(await readFile(join(dir, 'task.json'), 'utf-8'));
  delete task.tests.public;
  await writeFile(join(dir, 'task.json'), JSON.stringify(task, null, 2));
  await rm(join(dir, 'tests', 'public'), { recursive: true, force: true });
  return dir;
}

describe('optional public tests', () => {
  it('loads a task without tests.public, and still requires tests.hidden', async () => {
    const dir = await noPublicCopy();
    const task = await loadTask(dir);
    expect(task.paths.publicTests).toBeNull();
    const digests = await taskDigests(task);
    expect(digests.public_tests).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const raw = JSON.parse(await readFile(join(dir, 'task.json'), 'utf-8'));
    delete raw.tests.hidden;
    await writeFile(join(dir, 'task.json'), JSON.stringify(raw));
    await expect(loadTask(dir)).rejects.toThrow(/does not match the task schema/);
  });

  it('grades only the hidden suite and records the public suites as not_declared', async () => {
    const dir = await noPublicCopy();
    const solution = await readFile(join(dir, 'solution', 'solution.patch'), 'utf-8');
    const pass = await runEvaluation({ taskDir: dir, patch: solution });
    expect(pass.errors).toEqual([]);
    expect(pass.tests.public_baseline).toMatchObject({ state: 'not_declared', total: 0 });
    expect(pass.tests.public_after_patch).toMatchObject({ state: 'not_declared', total: 0 });
    expect(pass.tests.hidden).toMatchObject({ state: 'ok', total: 5, passed: 5 });
    expect(pass.score.total).toBe(100);
    expect(pass.evaluator_version).toBe(EVALUATOR_VERSION);
    const empty = await runEvaluation({ taskDir: dir, patch: '' });
    expect(empty.tests.hidden.state).toBe('ok');
    expect(empty.tests.hidden.failed).toBeGreaterThan(0);
    expect(empty.score.total).toBe(0);
  }, 300_000);

  it('passes the validation gate without public tests', async () => {
    const gate = await validateTask({ taskDir: await noPublicCopy(), repeats: 1 });
    expect(gate.checks.solution_passes).toMatchObject({ ok: true, hidden: '5/5', public: '0/0' });
    expect(gate.status).toBe('ready');
  }, 300_000);
});
