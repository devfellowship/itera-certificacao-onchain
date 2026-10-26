// Needs Docker and the sandbox image. Runs in CI after the image build:
//   ITERA_DOCKER_TESTS=1 ITERA_SANDBOX_IMAGE=itera-runner-sandbox:ci npx vitest run src/grade.integration.test.ts
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gradeInSandbox, validateTaskInSandbox } from './grade.js';
import { defaultSandboxConfig } from './sandbox.js';

const enabled = process.env.ITERA_DOCKER_TESTS === '1';
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const config = defaultSandboxConfig();
const probeTask = resolve(import.meta.dirname, '..', 'test-tasks', 'escape-probe');

describe.runIf(enabled)('grader sandbox (ADR-9, real Docker)', () => {
  it('denies the socket, the worker env, the network and writes to the workspace: the probe hidden suite is 0 / 5', async () => {
    // The worker process holds a DATABASE_URL; the grading container must not.
    process.env.DATABASE_URL = 'postgres://probe:probe@db.invalid/probe';
    const m = await gradeInSandbox({ runId: 'probe-0000', repoRoot, scenarioId: 'escape-probe', taskDir: probeTask, patch: '', config });
    expect(m.tests.public_after_patch).toMatchObject({ total: 1, passed: 1, state: 'ok' });
    expect(m.tests.hidden).toMatchObject({ total: 5, passed: 0, state: 'ok' });
    expect(m.environment?.executor.profile).toBe('sandbox-container');
    expect(m.environment?.executor.image_id).toMatch(/^sha256:/);
    expect(m.environment_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(m.evaluator_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(m).toHaveProperty('evaluator_commit');
  }, 300_000);

  it('grades tsk_webhook_dup with the golden solution at 100, as before', async () => {
    const patch = await readFile(join(repoRoot, 'benchmarks', 'tsk_webhook_dup', 'solution', 'solution.patch'), 'utf-8');
    const m = await gradeInSandbox({ runId: 'ledger-golden', repoRoot, scenarioId: 'tsk_webhook_dup', patch, config });
    expect(m.errors).toEqual([]);
    expect(m.tests.hidden).toMatchObject({ total: 5, passed: 5 });
    expect(m.score.total).toBe(100);
    expect(JSON.stringify(m)).not.toMatch(/\/tmp\/|itera-eval-|\/workspace\/w/);
  }, 300_000);

  it('runs the validation gate for tsk_webhook_dup in the sandbox: ready', async () => {
    const gate = await validateTaskInSandbox({ runId: 'ledger-gate', taskDir: join(repoRoot, 'benchmarks', 'tsk_webhook_dup'), config, repeats: 3 });
    expect(gate.checks.baseline_hidden_fails.ok).toBe(true);
    expect(gate.checks.repeatable).toMatchObject({ ok: true, runs: 3 });
    expect(gate.status).toBe('ready');
  }, 900_000);
});
