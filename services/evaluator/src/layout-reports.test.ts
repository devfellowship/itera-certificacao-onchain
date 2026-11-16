// Report drivers, the repo-paths test layout and verifier.cwd (plan 20261112-dfl-os-eval-cases-from-real-tasks
// ADR-5). The end-to-end task below has the shape of a real DFL monorepo case: an npm workspace link,
// node:test, hidden tests at their repository paths, no public tests, the verifier in one package.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseNodeTestTapText, parseReport } from './reports.js';
import { runEvaluation, workspaceRelative } from './runner.js';
import { interpretRun, resolveCmd } from './suite.js';
import { loadTask, suiteTests } from './task.js';
import { validateTask } from './validate.js';

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
}

/** Real TAP from the node that runs this test (no hand-written fixture). */
async function realTap(files: Record<string, string>): Promise<{ tap: string; exitCode: number | null }> {
  const dir = await tmp('itera-tap-');
  await put(dir, files);
  const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-reporter-destination=out.tap', ...Object.keys(files)], { cwd: dir, encoding: 'utf-8' });
  return { tap: await readFile(join(dir, 'out.tap'), 'utf-8'), exitCode: res.status };
}

const MIXED = {
  'a.test.mjs': [
    "import { test, describe, it } from 'node:test';",
    "import assert from 'node:assert';",
    "describe('suite one', () => {",
    "  it('passes', () => {});",
    "  it('fails', () => { assert.equal(1, 2); });",
    "  it.skip('skipped', () => {});",
    "  it.todo('todo thing');",
    "  describe('nested', () => { it('deep pass', () => {}); });",
    '});',
    "test('top with subtests', async (t) => { await t.test('sub a', () => {}); });",
    "test('top plain # weird name', () => {});",
  ].join('\n'),
  'b.test.mjs': 'throw new Error("boom");\n',
};

describe('report driver node-test-tap', () => {
  it('counts every test point except describe() blocks, with skip/todo as skipped', async () => {
    const { tap, exitCode } = await realTap(MIXED);
    const suite = parseNodeTestTapText(tap);
    expect(suite).toMatchObject({ total: 9, passed: 5, failed: 4, skipped: 2 });
    const names = suite.cases.map((c) => c.name);
    expect(names).toContain('suite one > nested > deep pass');
    expect(names).toContain('top with subtests > sub a');
    expect(names).toContain('top plain # weird name');
    expect(suite.cases.find((c) => c.name === 'suite one > fails')?.passed).toBe(false);
    expect(suite.cases.find((c) => c.name.endsWith('b.test.mjs'))?.passed).toBe(false);
    // node exits 1 on a failure: the report agrees, so the counts are trusted.
    expect(exitCode).toBe(1);
    const run = interpretRun({ exitCode, timedOut: false, durationMs: 1, report: tap, stderrTail: '' }, 'node-test-tap');
    expect(run.error).toBeNull();
    expect(run.suite.state).toBe('ok');
  });

  it('cross-checks the exit code: an all-pass report from a failing verifier is a mismatch', async () => {
    const { tap, exitCode } = await realTap({ 'ok.test.mjs': "import { test } from 'node:test';\ntest('a', () => {});\ntest('b', () => {});\n" });
    expect(exitCode).toBe(0);
    expect(interpretRun({ exitCode: 0, timedOut: false, durationMs: 1, report: tap, stderrTail: '' }, 'node-test-tap').suite).toMatchObject({ state: 'ok', total: 2, passed: 2 });
    expect(interpretRun({ exitCode: 1, timedOut: false, durationMs: 1, report: tap, stderrTail: '' }, 'node-test-tap').suite.state).toBe('report_mismatch');
  });

  it('drops the point of a test file with no test (never a vacuous pass); a file that does not load fails', async () => {
    const { tap, exitCode } = await realTap({ 'a.test.mjs': "import { test } from 'node:test';\ntest('a', () => {});\n", 'empty.test.mjs': '' });
    expect(exitCode).toBe(0);
    expect(parseNodeTestTapText(tap)).toMatchObject({ total: 1, passed: 1 });
    const only = await realTap({ 'empty.test.mjs': '' });
    const run = interpretRun({ exitCode: only.exitCode, timedOut: false, durationMs: 1, report: only.tap, stderrTail: '' }, 'node-test-tap');
    expect(run.suite.total).toBe(0);
    expect(run.error).toBe('verifier ran zero tests');
  });

  it('refuses a report that is not TAP, and an unknown format', () => {
    expect(interpretRun({ exitCode: 0, timedOut: false, durationMs: 1, report: '{"testResults":[]}', stderrTail: '' }, 'node-test-tap').suite.state).toBe('no_report');
    expect(() => parseReport('TAP version 13\n', 'junit')).toThrow(/unknown report format junit/);
  });
});

describe('{tests} expansion', () => {
  it('replaces a directory everywhere (mount dir) and expands a whole element into files (repo-paths)', () => {
    expect(resolveCmd(['vitest', 'run', '{tests}', '--dir={tests}'], 'tests/hidden')).toEqual(['vitest', 'run', 'tests/hidden', '--dir=tests/hidden']);
    expect(resolveCmd(['node', '--test', '{tests}', '-x'], ['a.test.mjs', 'b/c.test.mjs'])).toEqual(['node', '--test', 'a.test.mjs', 'b/c.test.mjs', '-x']);
    expect(() => resolveCmd(['--files={tests}'], ['a.test.mjs'])).toThrow(/whole argv element/);
  });

  it('maps a report path back to its repo-paths test file', () => {
    expect(workspaceRelative('/tmp/itera-eval-x/workspace/packages/lib/test/sum.test.mjs', 'tests/hidden', ['packages/lib/test/sum.test.mjs'])).toBe('packages/lib/test/sum.test.mjs');
    expect(workspaceRelative('/workspace/w/tests/hidden/a.test.ts', 'tests/hidden')).toBe('tests/hidden/a.test.ts');
  });
});

/** A monorepo-shaped task: workspace link, node:test, repo-paths hidden tests, verifier.cwd, no public tests. */
async function monorepoTask(edit: (task: Record<string, any>) => void = () => undefined): Promise<string> {
  const dir = await tmp('itera-monorepo-task-');
  await put(dir, {
    'instruction.md': '# Fix sum\n\nMake `sum` add its two arguments.\n',
    'environment/package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
    'environment/package-lock.json': JSON.stringify({
      name: 'mono', lockfileVersion: 3, requires: true,
      packages: { '': { name: 'mono', workspaces: ['packages/*'] }, 'node_modules/@mono/lib': { resolved: 'packages/lib', link: true }, 'packages/lib': { name: '@mono/lib', version: '1.0.0' } },
    }),
    'environment/packages/lib/package.json': JSON.stringify({ name: '@mono/lib', version: '1.0.0', type: 'module' }),
    'environment/packages/lib/src/sum.mjs': 'export function sum(a, b) {\n  return a - b;\n}\n',
    'environment/packages/lib/test/old.test.mjs': "import { test } from 'node:test';\ntest('old', () => {});\n",
    'tests/hidden/packages/lib/test/sum.test.mjs': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { sum } from '../src/sum.mjs';",
      "import { two } from './helper.mjs';",
      "test('adds', () => { assert.equal(sum(2, 3), 5); });",
      "test('adds two', () => { assert.equal(sum(two, two), 4); });",
      '',
    ].join('\n'),
    'tests/hidden/packages/lib/test/helper.mjs': 'export const two = 2;\n',
    'solution/solution.patch': [
      'diff --git a/packages/lib/src/sum.mjs b/packages/lib/src/sum.mjs',
      '--- a/packages/lib/src/sum.mjs',
      '+++ b/packages/lib/src/sum.mjs',
      '@@ -1,3 +1,3 @@',
      ' export function sum(a, b) {',
      '-  return a - b;',
      '+  return a + b;',
      ' }',
      '',
    ].join('\n'),
  });
  const task: Record<string, any> = {
    schema_version: '1.0',
    task: { name: 'test/monorepo-sum', version: '1.0.0', description: 'monorepo driver fixture' },
    instruction: 'instruction.md',
    environment: { dir: 'environment', install: ['npm', 'ci', '--no-audit', '--no-fund', '--offline'], lockfile: 'workspace-links', allow_internet: false },
    tests: { hidden: 'tests/hidden', mount: 'repo-paths' },
    solution: { patch: 'solution/solution.patch' },
    editable_paths: ['packages/**'],
    protected_paths: ['packages/*/test/**', 'package.json', 'package-lock.json', 'tests/**'],
    verifier: { cmd: ['node', '--test', '--test-reporter=tap', '--test-reporter-destination={report}', '{tests}'], report: 'node-test-tap', cwd: 'packages/lib', timeout_sec: 60 },
    agent: { timeout_sec: 60 },
    est_minutes: 1,
  };
  edit(task);
  await writeFile(join(dir, 'task.json'), JSON.stringify(task, null, 2));
  return dir;
}

describe('repo-paths layout + verifier.cwd + node-test-tap (monorepo case)', () => {
  it('loads the task: test files at their repo paths, {tests} relative to verifier.cwd', async () => {
    const task = await loadTask(await monorepoTask());
    expect(task.mount).toBe('repo-paths');
    expect(task.testFiles.hidden).toEqual(['packages/lib/test/sum.test.mjs']);
    expect(suiteTests(task, 'hidden')).toEqual(['test/sum.test.mjs']);
  });

  it.each([
    ['a hidden file that protected_paths does not cover', (t: any) => (t.protected_paths = ['tests/**', 'package.json']), /protected_paths must cover packages\/lib\/test\/helper.mjs/],
    ['{tests} inside a longer element', (t: any) => (t.verifier.cmd = ['node', '--test', '--test-reporter=tap', '--test-reporter-destination={report}', '--x={tests}']), /whole argv element/],
    ['a test file outside verifier.cwd', (t: any) => (t.verifier.cwd = 'packages/other'), /outside verifier.cwd/],
    ['no file that matches tests.files', (t: any) => (t.tests.files = ['**/*.spec.*']), /holds no test file/],
    ['a cwd with ..', (t: any) => (t.verifier.cwd = '../x'), /does not match the task schema/],
  ])('refuses %s', async (_label, edit, why) => {
    await expect(loadTask(await monorepoTask(edit))).rejects.toThrow(why);
  });

  it('grades: the reference passes, the empty answer fails, the hidden files override the tree', async () => {
    const dir = await monorepoTask();
    const solution = await readFile(join(dir, 'solution', 'solution.patch'), 'utf-8');
    const pass = await runEvaluation({ taskDir: dir, patch: solution });
    expect(pass.errors).toEqual([]);
    expect(pass.tests.public_baseline.state).toBe('not_declared');
    expect(pass.tests.hidden).toMatchObject({ state: 'ok', total: 2, passed: 2 });
    expect(pass.tests.hidden.cases.map((c) => c.name)).toEqual(['adds', 'adds two']);
    expect(pass.score.total).toBe(100);
    const empty = await runEvaluation({ taskDir: dir, patch: '' });
    expect(empty.tests.hidden).toMatchObject({ state: 'ok', total: 2, passed: 0 });
    expect(empty.score.total).toBe(0);
  }, 120_000);

  it('passes the validation gate; an emptied hidden test turns the gate red', async () => {
    const dir = await monorepoTask();
    const gate = await validateTask({ taskDir: dir, repeats: 1 });
    expect(gate.checks.solution_passes).toMatchObject({ ok: true, hidden: '2/2' });
    expect(gate.status).toBe('ready');
    await writeFile(join(dir, 'tests', 'hidden', 'packages', 'lib', 'test', 'sum.test.mjs'), '');
    const mutant = await validateTask({ taskDir: dir, repeats: 1 });
    expect(mutant.status).toBe('invalid');
    expect(mutant.checks.solution_passes.ok).toBe(false);
  }, 120_000);
});
