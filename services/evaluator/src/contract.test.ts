import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { globToRegExp, matchesAny } from './glob.js';
import { checkPatchScope } from './patch-scope.js';
import { runEvaluation, workspaceRelative } from './runner.js';
import { interpretRun } from './suite.js';
import { loadTask, TaskError } from './task.js';
import { validateTask } from './validate.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const ledgerDir = join(repoRoot, 'benchmarks', 'webhook-ledger');
const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A copy of webhook-ledger whose task.json is changed by `edit`. */
async function ledgerCopy(edit: (task: Record<string, any>) => void = () => undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'itera-task-test-'));
  tmpDirs.push(dir);
  await cp(ledgerDir, dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
  const task = JSON.parse(await readFile(join(dir, 'task.json'), 'utf-8'));
  edit(task);
  await writeFile(join(dir, 'task.json'), JSON.stringify(task, null, 2));
  return dir;
}

describe('globs', () => {
  it('matches ** across directories and * inside one segment', () => {
    expect(matchesAny('src/a/b.ts', ['src/**'])).toBe(true);
    expect(matchesAny('src', ['src/**'])).toBe(true);
    expect(matchesAny('srcx/a.ts', ['src/**'])).toBe(false);
    expect(matchesAny('vitest.config.ts', ['vitest.config.*'])).toBe(true);
    expect(matchesAny('a/vitest.config.ts', ['vitest.config.*'])).toBe(false);
    expect(matchesAny('deep/x/y.test.ts', ['**/*.test.ts'])).toBe(true);
    expect(matchesAny('y.test.ts', ['**/*.test.ts'])).toBe(true);
  });
  it('treats a plain name as the path and everything under it', () => {
    expect(globToRegExp('tests').test('tests/a.ts')).toBe(true);
    expect(globToRegExp('package.json').test('package.json.bak')).toBe(false);
  });
});

describe('patch scope from the contract', () => {
  const rules = { editable: ['lib/**'], protected: ['tests/**'] };
  it('marks a patch to tests/ as a violation even when lib/** is editable', () => {
    const r = checkPatchScope(['lib/a.ts', 'tests/x.test.ts'], rules);
    expect(r.allowed).toBe(false);
    expect(r.violations).toEqual(['tests/x.test.ts']);
  });
  it('rejects src/ when only lib/** is editable', () => {
    expect(checkPatchScope(['src/a.ts'], rules).allowed).toBe(false);
    expect(checkPatchScope(['lib/deep/a.ts'], rules).allowed).toBe(true);
  });
  it('rejects a symbolic link even inside the editable paths', () => {
    const r = checkPatchScope(['lib/link.ts'], rules, ['lib/link.ts']);
    expect(r).toEqual({ allowed: false, violations: ['lib/link.ts'] });
  });
});

describe('loadTask (Ajv + bundle checks)', () => {
  it('accepts the converted webhook-ledger', async () => {
    const task = await loadTask(ledgerDir);
    expect(task.contract.task.name).toBe('itera/webhook-ledger');
    expect(task.contractDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects a task.json without verifier.cmd', async () => {
    const dir = await ledgerCopy((t) => delete t.verifier.cmd);
    await expect(loadTask(dir)).rejects.toThrow(/verifier.*cmd/);
  });
  it('rejects a verifier command without {report}', async () => {
    const dir = await ledgerCopy((t) => (t.verifier.cmd = ['npx', 'vitest', 'run', '{tests}']));
    await expect(loadTask(dir)).rejects.toThrow(TaskError);
  });
  it('rejects a path that leaves the bundle', async () => {
    const dir = await ledgerCopy((t) => (t.tests.hidden = '../other'));
    await expect(loadTask(dir)).rejects.toThrow(/task schema/);
  });
  it('rejects allow_internet: true', async () => {
    const dir = await ledgerCopy((t) => (t.environment.allow_internet = true));
    await expect(loadTask(dir)).rejects.toThrow(/allow_internet/);
  });
  it('rejects protected_paths that do not cover the hidden tests', async () => {
    const dir = await ledgerCopy((t) => (t.protected_paths = ['package.json']));
    await expect(loadTask(dir)).rejects.toThrow(/must cover/);
  });
  it('rejects a symbolic link in the bundle', async () => {
    const dir = await ledgerCopy();
    await symlink('/etc/hostname', join(dir, 'environment', 'src', 'leak.ts'));
    await expect(loadTask(dir)).rejects.toThrow(/symbolic links/);
  });
  it('rejects a lockfile that resolves outside the npm registry', async () => {
    const dir = await ledgerCopy();
    const lockPath = join(dir, 'environment', 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.packages['node_modules/evil'] = { version: '1.0.0', resolved: 'https://attacker.example/evil.tgz' };
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(loadTask(dir)).rejects.toThrow(/outside the npm registry/);
  });
});

describe('interpretRun (report vs exit code)', () => {
  const report = (statuses: string[]) =>
    JSON.stringify({ testResults: [{ name: '/w/tests/a.test.ts', assertionResults: statuses.map((s, i) => ({ title: `t${i}`, fullName: `t${i}`, status: s })) }] });
  const base = { timedOut: false, durationMs: 10, stderrTail: '' };
  it('trusts a report that agrees with the exit code', () => {
    expect(interpretRun({ ...base, exitCode: 0, report: report(['passed', 'passed']) }).suite.state).toBe('ok');
    expect(interpretRun({ ...base, exitCode: 1, report: report(['passed', 'failed']) }).suite.state).toBe('ok');
    expect(interpretRun({ ...base, exitCode: 0, report: report(['passed', 'skipped']) }).suite.state).toBe('ok');
  });
  it('flags an all-pass report from a failing verifier as a mismatch (forged report)', () => {
    const r = interpretRun({ ...base, exitCode: 1, report: report(['passed', 'passed']) });
    expect(r.suite.state).toBe('report_mismatch');
    expect(r.error).toMatch(/disagrees/);
  });
  it('turns a missing or broken report into an error, never a zero-test pass', () => {
    expect(interpretRun({ ...base, exitCode: 1, report: null }).suite.state).toBe('no_report');
    expect(interpretRun({ ...base, exitCode: 0, report: '{}' }).error).toMatch(/does not parse/);
    expect(interpretRun({ ...base, exitCode: 0, report: JSON.stringify({ testResults: [] }) }).error).toMatch(/zero tests/);
    expect(interpretRun({ ...base, exitCode: null, timedOut: true, report: null }).suite.state).toBe('timeout');
  });
  it('keeps only the workspace-relative test path', () => {
    expect(workspaceRelative('/tmp/itera-eval-x/workspace/tests/hidden/h.test.ts', 'tests/hidden')).toBe('tests/hidden/h.test.ts');
    expect(workspaceRelative('/workspace/w/tests/public/p.test.ts', 'tests/public')).toBe('tests/public/p.test.ts');
  });
});

describe('generic verifier on the webhook-ledger contract (integration, local executor)', () => {
  it('scores the solution/ patch 100 with pinned-environment evidence and no temp path', async () => {
    const patch = await readFile(join(ledgerDir, 'solution', 'solution.patch'), 'utf-8');
    const m = await runEvaluation({ taskDir: ledgerDir, patch });
    expect(m.errors).toEqual([]);
    expect(m.score.total).toBe(100);
    expect(m.tests.hidden).toMatchObject({ total: 5, passed: 5, state: 'ok' });
    expect(m.contract?.contract_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(m.environment_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(m.environment?.install_cmd).toContain('--ignore-scripts');
    expect(m.evaluator_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(m)).not.toMatch(/\/tmp\/|itera-eval-/);
  }, 180_000);

  it('counts a rename out of tests/ as a change to tests/', async () => {
    const patch = [
      'diff --git a/tests/public/public.test.ts b/src/moved.test.ts',
      'similarity index 100%',
      'rename from tests/public/public.test.ts',
      'rename to src/moved.test.ts',
      '',
    ].join('\n');
    const m = await runEvaluation({ taskDir: ledgerDir, patch });
    expect(m.patch_scope.allowed).toBe(false);
    expect(m.patch_scope.violations).toContain('tests/public/public.test.ts');
    expect(m.score.total).toBe(0);
  }, 180_000);

  it('passes the validation gate: baseline fails hidden, solution passes 3 / 3, inside the time budget', async () => {
    const gate = await validateTask({ taskDir: ledgerDir, repeats: 3 });
    expect(gate.checks.baseline_hidden_fails.ok).toBe(true);
    expect(gate.checks.solution_passes).toMatchObject({ ok: true, hidden: '5/5', public: '3/3' });
    expect(gate.checks.repeatable).toMatchObject({ ok: true, runs: 3 });
    expect(gate.checks.verifier_time.ok).toBe(true);
    expect(gate.status).toBe('ready');
    expect(JSON.stringify(gate)).not.toMatch(/invalid signature|concurrent/);
  }, 600_000);

  it('marks a task invalid when the solution does not solve it', async () => {
    const dir = await ledgerCopy();
    await writeFile(join(dir, 'solution', 'solution.patch'), '');
    const gate = await validateTask({ taskDir: dir, repeats: 1 });
    expect(gate.status).toBe('invalid');
    expect(gate.checks.solution_passes.ok).toBe(false);
  }, 300_000);
});
