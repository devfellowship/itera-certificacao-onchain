// Build driver (plan 20261112-dfl-os-eval-cases-from-real-tasks ADR-5): environment.build runs after
// the patch, before each verifier run, in the same sandbox. The fixture has the shape of a DFL
// monorepo case: the hidden test imports a workspace package from its dist/, which only the build
// writes (install runs with --ignore-scripts, so nothing else builds it).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EVALUATOR_VERSION, runEvaluation } from './runner.js';
import { BUILD_FAILED_MARKER, interpretRun } from './suite.js';
import { loadTask } from './task.js';
import { validateTask } from './validate.js';

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const BUILD_SCRIPT = [
  "import { cpSync, mkdirSync } from 'node:fs';",
  "if (process.argv[2] === 'fail') { console.log('src/sum.mjs(1,1): error TS0000: broken'); process.exit(2); }",
  "mkdirSync('packages/lib/dist', { recursive: true });",
  "cpSync('packages/lib/src/sum.mjs', 'packages/lib/dist/sum.mjs');",
  '',
].join('\n');

async function buildTask(edit: (task: Record<string, any>) => void = () => undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'itera-build-task-'));
  tmpDirs.push(dir);
  const files: Record<string, string> = {
    'instruction.md': '# Fix sum\n\nMake `sum` add its two arguments.\n',
    'environment/package.json': JSON.stringify({ name: 'mono', private: true, type: 'module', workspaces: ['packages/*'] }),
    'environment/package-lock.json': JSON.stringify({
      name: 'mono', lockfileVersion: 3, requires: true,
      packages: { '': { name: 'mono', workspaces: ['packages/*'] }, 'node_modules/@mono/lib': { resolved: 'packages/lib', link: true }, 'packages/lib': { name: '@mono/lib', version: '1.0.0' } },
    }),
    'environment/build.mjs': BUILD_SCRIPT,
    'environment/packages/lib/package.json': JSON.stringify({ name: '@mono/lib', version: '1.0.0', type: 'module', main: 'dist/sum.mjs' }),
    'environment/packages/lib/src/sum.mjs': 'export function sum(a, b) {\n  return a - b;\n}\n',
    'tests/hidden/packages/lib/test/sum.test.mjs': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { sum } from '../dist/sum.mjs';",
      "test('adds', () => { assert.equal(sum(2, 3), 5); });",
      '',
    ].join('\n'),
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
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  const task: Record<string, any> = {
    schema_version: '1.0',
    task: { name: 'test/build-sum', version: '1.0.0', description: 'build driver fixture' },
    instruction: 'instruction.md',
    environment: {
      dir: 'environment',
      install: ['npm', 'ci', '--no-audit', '--no-fund', '--offline'],
      lockfile: 'workspace-links',
      build: { cmd: ['node', 'build.mjs'], outputs: ['packages/*/dist'], timeout_sec: 30 },
      allow_internet: false,
    },
    tests: { hidden: 'tests/hidden', mount: 'repo-paths' },
    solution: { patch: 'solution/solution.patch' },
    editable_paths: ['packages/*/src/**'],
    protected_paths: ['packages/*/test/**', 'build.mjs', 'package.json', 'package-lock.json', 'tests/**'],
    verifier: { cmd: ['node', '--test', '--test-reporter=tap', '--test-reporter-destination={report}', '{tests}'], report: 'node-test-tap', cwd: 'packages/lib', timeout_sec: 60 },
    agent: { timeout_sec: 60 },
    est_minutes: 1,
  };
  edit(task);
  await writeFile(join(dir, 'task.json'), JSON.stringify(task, null, 2));
  return dir;
}

describe('build driver (environment.build)', () => {
  it('is version 0.6.0 of the hidden-tests grader', () => {
    expect(EVALUATOR_VERSION).toBe('0.6.0');
  });

  it.each([
    ['an output under node_modules', ['node_modules/x'], /under node_modules/],
    ['an output that matches protected_paths', ['packages/*/test'], /matches protected_paths/],
    ['an output with ..', ['../dist'], /does not match the task schema/],
    ['an output with a . segment', ['packages/./dist'], /does not match the task schema/],
  ])('refuses %s', async (_label, outputs, why) => {
    await expect(loadTask(await buildTask((t) => (t.environment.build.outputs = outputs)))).rejects.toThrow(why);
  });

  it('builds the patched code before the hidden suite: the reference passes, the empty answer fails', async () => {
    const dir = await buildTask();
    const pass = await runEvaluation({ taskDir: dir, patch: await readFile(join(dir, 'solution', 'solution.patch'), 'utf-8') });
    expect(pass.errors).toEqual([]);
    expect(pass.tests.hidden).toMatchObject({ state: 'ok', total: 1, passed: 1 });
    expect(pass.score.total).toBe(100);
    const empty = await runEvaluation({ taskDir: dir, patch: '' });
    expect(empty.tests.hidden).toMatchObject({ state: 'ok', total: 1, passed: 0 });
    expect(empty.score.total).toBe(0);
  }, 120_000);

  it('without the build the dist import fails: the build step is what makes the reference pass', async () => {
    const dir = await buildTask((t) => delete t.environment.build);
    const run = await runEvaluation({ taskDir: dir, patch: await readFile(join(dir, 'solution', 'solution.patch'), 'utf-8') });
    expect(run.tests.hidden.passed).toBe(0);
  }, 120_000);

  it('a failed build is a suite with no report and the error "build failed" (with the tool output)', async () => {
    const dir = await buildTask((t) => (t.environment.build.cmd = ['node', 'build.mjs', 'fail']));
    const run = await runEvaluation({ taskDir: dir, patch: await readFile(join(dir, 'solution', 'solution.patch'), 'utf-8') });
    expect(run.tests.hidden.state).toBe('no_report');
    expect(run.errors.join('\n')).toMatch(/hidden: build failed: .*error TS0000: broken/s);
    expect(interpretRun({ exitCode: 97, timedOut: false, durationMs: 1, report: null, stderrTail: `x\n${BUILD_FAILED_MARKER}` }).error).toMatch(/^build failed/);
  }, 120_000);

  it('passes the validation gate', async () => {
    const gate = await validateTask({ taskDir: await buildTask(), repeats: 1 });
    expect(gate.checks.solution_passes).toMatchObject({ ok: true, hidden: '1/1' });
    expect(gate.status).toBe('ready');
  }, 120_000);
});
