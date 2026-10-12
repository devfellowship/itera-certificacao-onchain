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
  it('pass when every suite ran and the score is above 0', () => {
    expect(finalStatus(agent, m())).toBe('pass');
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
