import { describe, expect, it } from 'vitest';
import { computeScore, SCORE_WEIGHTS } from './score.js';
import type { TestSuiteResult } from './types.js';

function suite(total: number, passed: number): TestSuiteResult {
  return { total, passed, failed: total - passed, cases: [] };
}

describe('computeScore', () => {
  it('awards full marks for a fully passing, in-scope, error-free run', () => {
    const score = computeScore({
      publicAfterPatch: suite(3, 3),
      hidden: suite(5, 5),
      regressionRatio: 1,
      patchScopeAllowed: true,
      runCompletedWithoutErrors: true,
    });
    expect(score.total).toBe(100);
    expect(score).toEqual({
      public_behavior: SCORE_WEIGHTS.public_behavior,
      hidden_behavior: SCORE_WEIGHTS.hidden_behavior,
      regression: SCORE_WEIGHTS.regression,
      patch_integrity_and_scope: SCORE_WEIGHTS.patch_integrity_and_scope,
      reproducible_evidence: SCORE_WEIGHTS.reproducible_evidence,
      total: 100,
    });
  });

  it('scores zero across every axis for the unfixed fixture baseline', () => {
    // Matches benchmarks/webhook-ledger: 1/3 public and 4/5 hidden fail pre-fix.
    const score = computeScore({
      publicAfterPatch: suite(3, 2),
      hidden: suite(5, 1),
      regressionRatio: 1,
      patchScopeAllowed: true,
      runCompletedWithoutErrors: true,
    });
    expect(score.public_behavior).toBe(13); // round(2/3 * 20)
    expect(score.hidden_behavior).toBe(10); // round(1/5 * 50)
    expect(score.total).toBe(13 + 10 + 15 + 10 + 5);
  });

  it('zeroes patch_integrity_and_scope when the patch touches forbidden paths', () => {
    const score = computeScore({
      publicAfterPatch: suite(3, 3),
      hidden: suite(5, 5),
      regressionRatio: 1,
      patchScopeAllowed: false,
      runCompletedWithoutErrors: true,
    });
    expect(score.patch_integrity_and_scope).toBe(0);
    expect(score.total).toBe(100 - SCORE_WEIGHTS.patch_integrity_and_scope);
  });

  it('zeroes reproducible_evidence when the run hit an internal error', () => {
    const score = computeScore({
      publicAfterPatch: suite(3, 3),
      hidden: suite(5, 5),
      regressionRatio: 1,
      patchScopeAllowed: true,
      runCompletedWithoutErrors: false,
    });
    expect(score.reproducible_evidence).toBe(0);
  });

  it('penalizes a patch that breaks a previously passing public test', () => {
    const score = computeScore({
      publicAfterPatch: suite(3, 3),
      hidden: suite(5, 5),
      regressionRatio: 0.5, // half of baseline-passing tests regressed
      patchScopeAllowed: true,
      runCompletedWithoutErrors: true,
    });
    expect(score.regression).toBe(8); // round(0.5 * 15)
  });

  it('treats an empty test suite as zero behavior score, not a divide-by-zero crash', () => {
    const score = computeScore({
      publicAfterPatch: suite(0, 0),
      hidden: suite(0, 0),
      regressionRatio: 1,
      patchScopeAllowed: true,
      runCompletedWithoutErrors: true,
    });
    expect(score.public_behavior).toBe(0);
    expect(score.hidden_behavior).toBe(0);
  });
});
