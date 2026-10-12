// The validation gate of a task version (ADR-8). A task is usable only when:
//   (i)   baseline: on the untouched environment, the hidden tests FAIL (at least one case fails),
//         so the task is not already solved;
//   (ii)  solution: with solution/ applied, the patch is in scope and every public and hidden case PASSES;
//   (iii) repeatability: (ii) gives the same result on every repeat (default 3 runs);
//   (iv)  time: every verifier run ends inside task.json verifier.timeout_sec.
// The result names no test: only counts, so it is safe to show to the task author and to store.
import { readFile } from 'node:fs/promises';
import { runEvaluation } from './runner.js';
import type { SuiteExecutor } from './suite.js';
import { loadTask, taskDigests, TaskError } from './task.js';
import type { EvidenceManifest, TestSuiteResult } from './types.js';

export interface GateCheck {
  ok: boolean;
  detail: string;
}

export interface ValidationResult {
  status: 'ready' | 'invalid';
  checks: {
    contract: GateCheck;
    baseline_hidden_fails: GateCheck & { hidden_total: number; hidden_failed: number };
    solution_passes: GateCheck & { public: string; hidden: string; scope_allowed: boolean };
    repeatable: GateCheck & { runs: number; identical: boolean };
    verifier_time: GateCheck & { max_ms: number; budget_ms: number };
  };
  digests: Record<string, string> | null;
  environment_digest: string | null;
  duration_ms: number;
}

const ratio = (s: TestSuiteResult) => `${s.passed}/${s.total}`;
const suites = (m: EvidenceManifest) => [m.tests.public_baseline, m.tests.public_after_patch, m.tests.hidden];
const fingerprint = (m: EvidenceManifest) =>
  JSON.stringify([ratio(m.tests.public_after_patch), ratio(m.tests.hidden), m.score.total, m.patch_scope.allowed, m.errors.length]);
/** Errors without test names or paths: the first words of each line only. */
const safeErrors = (m: EvidenceManifest) => m.errors.map((e) => e.split(':')[0]).join(', ');

export async function validateTask(opts: { taskDir: string; executor?: SuiteExecutor; repeats?: number }): Promise<ValidationResult> {
  const started = Date.now();
  const repeats = Math.max(1, Math.min(5, opts.repeats ?? 3));
  const fail = (detail: string): GateCheck => ({ ok: false, detail });
  const result: ValidationResult = {
    status: 'invalid',
    checks: {
      contract: fail('not checked'),
      baseline_hidden_fails: { ...fail('not checked'), hidden_total: 0, hidden_failed: 0 },
      solution_passes: { ...fail('not checked'), public: '0/0', hidden: '0/0', scope_allowed: false },
      repeatable: { ...fail('not checked'), runs: 0, identical: false },
      verifier_time: { ...fail('not checked'), max_ms: 0, budget_ms: 0 },
    },
    digests: null,
    environment_digest: null,
    duration_ms: 0,
  };
  const finish = () => {
    result.duration_ms = Date.now() - started;
    result.status = Object.values(result.checks).every((c) => c.ok) ? 'ready' : 'invalid';
    return result;
  };

  let task;
  try {
    task = await loadTask(opts.taskDir);
    result.digests = await taskDigests(task);
    result.checks.contract = { ok: true, detail: `${task.contract.task.name}@${task.contract.task.version}` };
  } catch (err) {
    result.checks.contract = fail(err instanceof TaskError ? err.message : `task could not be read: ${String(err)}`);
    return finish();
  }
  const budgetMs = task.contract.verifier.timeout_sec * 1000;
  result.checks.verifier_time.budget_ms = budgetMs;
  const manifests: EvidenceManifest[] = [];

  // (i) baseline: no patch at all.
  const baseline = await runEvaluation({ taskDir: opts.taskDir, patch: '', executor: opts.executor });
  manifests.push(baseline);
  result.environment_digest = baseline.environment_digest ?? null;
  const h = baseline.tests.hidden;
  result.checks.baseline_hidden_fails = {
    ok: h.state === 'ok' && h.total > 0 && h.failed > 0,
    detail:
      h.state !== 'ok' || h.total === 0
        ? `hidden tests did not run on the baseline (${safeErrors(baseline) || h.state})`
        : h.failed > 0
          ? `FAIL as expected: ${h.failed} of ${h.total} hidden cases fail`
          : `all ${h.total} hidden cases already pass on the baseline`,
    hidden_total: h.total,
    hidden_failed: h.failed,
  };

  // (ii) + (iii) the reference solution, `repeats` times.
  const solution = await readFile(task.paths.solution, 'utf-8');
  const runs: EvidenceManifest[] = [];
  for (let i = 0; i < repeats; i++) {
    runs.push(await runEvaluation({ taskDir: opts.taskDir, patch: solution, executor: opts.executor }));
  }
  manifests.push(...runs);
  const first = runs[0]!;
  const pub = first.tests.public_after_patch;
  const hid = first.tests.hidden;
  const passes = (s: TestSuiteResult) => s.state === 'ok' && s.total > 0 && s.passed === s.total;
  const solved = first.patch_scope.allowed && first.errors.length === 0 && passes(pub) && passes(hid);
  result.checks.solution_passes = {
    ok: solved,
    detail: solved
      ? `${hid.passed} / ${hid.total} hidden PASS, ${pub.passed} / ${pub.total} public PASS`
      : !first.patch_scope.allowed
        ? `the solution touches paths outside editable_paths (${first.patch_scope.violations.length} file(s))`
        : first.errors.length > 0
          ? `the solution run had errors (${safeErrors(first)})`
          : `the solution does not pass: hidden ${ratio(hid)}, public ${ratio(pub)}`,
    public: ratio(pub),
    hidden: ratio(hid),
    scope_allowed: first.patch_scope.allowed,
  };
  const identical = runs.every((m) => fingerprint(m) === fingerprint(first));
  result.checks.repeatable = {
    ok: identical && solved,
    detail: identical ? `${repeats} / ${repeats} same result` : `results differ across ${repeats} runs`,
    runs: repeats,
    identical,
  };

  // (iv) time: the slowest single verifier run of the whole gate.
  const durations = manifests.flatMap(suites).map((s) => s.duration_ms ?? 0);
  const timedOut = manifests.flatMap(suites).some((s) => s.state === 'timeout');
  const maxMs = Math.max(0, ...durations);
  result.checks.verifier_time = {
    ok: !timedOut && maxMs <= budgetMs,
    detail: timedOut ? `a verifier run hit the ${budgetMs / 1000} s limit` : `${Math.round(maxMs / 1000)} s (limit ${budgetMs / 1000} s)`,
    max_ms: maxMs,
    budget_ms: budgetMs,
  };
  return finish();
}
