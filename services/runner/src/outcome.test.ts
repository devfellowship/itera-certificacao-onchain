import { describe, expect, it } from 'vitest';
import type { EvidenceManifest } from '../../evaluator/src/types.js';
import { finalStatus, statusError, zeroTestSuites } from './outcome.js';

const suite = (total: number, passed = total) => ({ total, passed, failed: total - passed, cases: [] });
function m(over: Partial<EvidenceManifest['tests']> = {}, total = 70): EvidenceManifest {
  return {
    schema_version: '0.1.0', evaluator_version: '0.1.0', scenario_id: 's', generated_at: '', fixture_hash: '', patch_hash: '',
    patch_scope: { changed_files: ['src/a.ts'], allowed: true, violations: [] },
    tests: { public_baseline: suite(3, 2), public_after_patch: suite(3), hidden: suite(5), ...over },
    score: { public_behavior: 20, hidden_behavior: 50, regression: 0, patch_integrity_and_scope: 0, reproducible_evidence: 0, total },
    errors: [],
  };
}
const agent = { timedOut: false, patch: 'diff --git a/src/a.ts b/src/a.ts\n' };

describe('finalStatus — zero tests is never a pass', () => {
  it('pass when every suite ran and every hidden test passed (5/5)', () => {
    expect(finalStatus(agent, m())).toBe('pass');
  });
  it('fail, score kept, when a scored run misses a hidden test (4/5 = score 90)', () => {
    const manifest = m({ hidden: suite(5, 4) }, 90);
    expect(finalStatus(agent, manifest)).toBe('fail');
    expect(manifest.score.total).toBe(90);
  });
  it('fail when no hidden test passes (0/5), even with a positive score from other parts', () => {
    expect(finalStatus(agent, m({ hidden: suite(5, 0) }, 40))).toBe('fail');
  });
  it('a skipped hidden test is not a pass', () => {
    expect(finalStatus(agent, m({ hidden: { total: 5, passed: 4, failed: 1, skipped: 1, cases: [] } }, 90))).toBe('fail');
  });
  it('infra_error (unscored) when the hidden report was not trusted or grading recorded errors', () => {
    expect(finalStatus(agent, m({ hidden: { ...suite(5), state: 'report_mismatch' } }))).toBe('infra_error');
    expect(finalStatus(agent, { ...m(), errors: ['verifier timed out'] })).toBe('infra_error');
  });
  it('invalid on a scope violation even when every hidden test passes', () => {
    expect(finalStatus(agent, { ...m(), patch_scope: { changed_files: ['tests/x'], allowed: false, violations: ['tests/x'] } })).toBe('invalid');
  });
  it.each(['public_baseline', 'public_after_patch', 'hidden'] as const)('infra_error when %s executed 0 tests', (k) => {
    const manifest = m({ [k]: suite(0) }, 30);
    expect(zeroTestSuites(manifest)).toEqual([k]);
    expect(finalStatus(agent, manifest)).toBe('infra_error');
    expect(statusError('infra_error', manifest, [])).toBe(`grading inconclusive: no test executed in ${k}`);
  });
  it('timeout, fail (empty patch) and invalid (scope) keep their meaning', () => {
    expect(finalStatus({ ...agent, timedOut: true }, m())).toBe('timeout');
    expect(finalStatus({ ...agent, patch: '' }, m())).toBe('fail');
    expect(finalStatus(agent, { ...m(), patch_scope: { changed_files: ['x'], allowed: false, violations: ['x'] } })).toBe('invalid');
  });
});
