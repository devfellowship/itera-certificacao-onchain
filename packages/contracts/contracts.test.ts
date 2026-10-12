import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateTaskContract } from './index.js';

const ledger = JSON.parse(readFileSync(new URL('../../benchmarks/webhook-ledger/task.json', import.meta.url), 'utf-8'));
const clone = () => structuredClone(ledger);

describe('task.schema.json (Ajv, draft 2020-12)', () => {
  it('accepts the webhook-ledger contract', () => {
    expect(validateTaskContract(ledger)).toMatchObject({ ok: true });
  });
  it('rejects a task.json without verifier.cmd', () => {
    const t = clone();
    delete t.verifier.cmd;
    const r = validateTaskContract(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/cmd/);
  });
  it('rejects unknown keys, absolute and parent paths, and network', () => {
    for (const edit of [
      (t: any) => (t.extra = 1),
      (t: any) => (t.environment.dir = '/etc'),
      (t: any) => (t.tests.hidden = 'tests/../../x'),
      (t: any) => (t.environment.allow_internet = true),
      (t: any) => (t.verifier.timeout_sec = 9999),
      (t: any) => (t.task.name = 'no-org'),
    ]) {
      const t = clone();
      edit(t);
      expect(validateTaskContract(t).ok).toBe(false);
    }
  });
});

import { isEvidenceManifest, runResult, validateEvidenceManifest } from './index.js';

describe('evidence-manifest.schema.json (the per-run EvalLog)', () => {
  const legacy = {
    scenario_id: 'webhook-ledger',
    patch_hash: 'p',
    patch_scope: { changed_files: [], allowed: true },
    tests: { public_baseline: { total: 1, passed: 1, failed: 0 }, public_after_patch: { total: 1, passed: 1, failed: 0 }, hidden: { total: 1, passed: 0, failed: 1 } },
    score: { total: 70 },
    errors: [],
  };
  it('accepts an old (evaluator 0.1.0) row and refuses a non-graded one', () => {
    expect(isEvidenceManifest(legacy)).toBe(true);
    expect(isEvidenceManifest({ error: 'grading failed' })).toBe(false);
    expect(isEvidenceManifest({ ...legacy, score: { total: '70' } })).toBe(false);
  });
  it('checks the Inspect Score shape: value is a number or null (unscored)', () => {
    const sample = (value: unknown) => ({ ...legacy, samples: [{ id: 't', epoch: 1, input: 'x', target: 'y', scores: { hidden_behavior: { value } } }] });
    expect(validateEvidenceManifest(sample(null)).ok).toBe(true);
    expect(validateEvidenceManifest(sample(50)).ok).toBe(true);
    expect(validateEvidenceManifest(sample('50')).ok).toBe(false);
  });
});

describe('runResult (state kept apart from verdict)', () => {
  it('maps every runs.status', () => {
    expect(runResult('queued')).toEqual({ state: 'queued', verdict: null, scored: false });
    expect(runResult('pass')).toEqual({ state: 'completed', verdict: 'pass', scored: true });
    expect(runResult('timeout')).toEqual({ state: 'timeout', verdict: 'invalid', scored: true });
    expect(runResult('infra_error')).toEqual({ state: 'infra_error', verdict: 'inconclusive', scored: false });
  });
  it('prefers the result the runner wrote in the EvalLog', () => {
    expect(runResult('fail', { result: { state: 'completed', verdict: 'fail', scored: true } })).toEqual({ state: 'completed', verdict: 'fail', scored: true });
  });
});
