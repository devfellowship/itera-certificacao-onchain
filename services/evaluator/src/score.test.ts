import { describe, expect, it } from 'vitest';
import { computeScore, hiddenRatioScore, SCORE_WEIGHTS } from './score.js';
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

  it('zeroes the whole total (not just the scope component) when the patch touches forbidden paths', () => {
    // A scope violation zeros score.total, not just patch_integrity_and_scope — otherwise a
    // patch that edits its own grader still collects the other 90 points. See PR #12.
    const score = computeScore({
      publicAfterPatch: suite(3, 3),
      hidden: suite(5, 5),
      regressionRatio: 1,
      patchScopeAllowed: false,
      runCompletedWithoutErrors: true,
    });
    expect(score.patch_integrity_and_scope).toBe(0);
    expect(score.total).toBe(0);
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

describe('hiddenRatioScore (score version 2, TMA-QC = B)', () => {
  const base = { patchEmpty: false, patchScopeAllowed: true, mcpStateHolds: null, legacyTotal: 0 };

  it('scores hidden ratio × 100 when every gate holds', () => {
    expect(hiddenRatioScore({ ...base, hidden: suite(13, 13) }).total).toBe(100);
    expect(hiddenRatioScore({ ...base, hidden: suite(20, 14) }).total).toBe(70);
    // Rounded like every other part: Math.round.
    expect(hiddenRatioScore({ ...base, hidden: suite(13, 10) }).total).toBe(77); // 76.9
    expect(hiddenRatioScore({ ...base, hidden: suite(13, 1) }).total).toBe(8); // 7.7
    expect(hiddenRatioScore({ ...base, hidden: suite(5, 0) }).total).toBe(0);
  });

  it('scores 0 for a no-op (empty patch), whatever the free parts would pay', () => {
    // Build lanes: an empty patch scored 69 (A), 22 (B), 88 (C) under version 1.
    const r = hiddenRatioScore({ ...base, hidden: suite(6, 3), patchEmpty: true, legacyTotal: 88 });
    expect(r.total).toBe(0);
    expect(r.rule.gates.patch_nonempty).toBe(false);
    expect(r.rule.legacy_total).toBe(88);
  });

  it('scores 0 when the safety gate breaks (scope violation = INVALID)', () => {
    // K7 run 2f98d3cb: 19/20 hidden checks, scope violation → 0.
    expect(hiddenRatioScore({ ...base, hidden: suite(20, 19), patchScopeAllowed: false }).total).toBe(0);
  });

  it('scores 0 when an MCP final-state assertion does not hold', () => {
    expect(hiddenRatioScore({ ...base, hidden: suite(6, 6), mcpStateHolds: false }).total).toBe(0);
    expect(hiddenRatioScore({ ...base, hidden: suite(6, 6), mcpStateHolds: true }).total).toBe(100);
  });

  it('scores 0 with 0 hidden checks or an untrusted hidden report (no divide by zero)', () => {
    const zero = hiddenRatioScore({ ...base, hidden: suite(0, 0) });
    expect(zero.total).toBe(0);
    expect(zero.rule.hidden).toBeNull();
    expect(zero.rule.gates.hidden_measured).toBe(false);
    expect(hiddenRatioScore({ ...base, hidden: { ...suite(5, 5), state: 'timeout' } }).total).toBe(0);
  });

  it('records the formula, the hidden ratio and the gates', () => {
    const r = hiddenRatioScore({ ...base, hidden: suite(13, 13), mcpStateHolds: true, legacyTotal: 100 });
    expect(r.rule).toEqual({
      formula: 'hidden_ratio_x100_gated',
      hidden: '13/13',
      gates: { hidden_measured: true, patch_nonempty: true, patch_scope: true, mcp_state: true },
      legacy_total: 100,
    });
  });
});
