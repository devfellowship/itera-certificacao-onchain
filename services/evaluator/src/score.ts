import type { ScoreBreakdown, TestSuiteResult } from './types.js';

// Weights match benchmarks/scenarios.json's shared_protocol.score_100 exactly — do not change
// one side without the other, or a manifest's score stops matching the scenario spec it claims
// to score against.
export const SCORE_WEIGHTS = {
  public_behavior: 20,
  hidden_behavior: 50,
  regression: 15,
  patch_integrity_and_scope: 10,
  reproducible_evidence: 5,
} as const;

function suiteRatio(suite: TestSuiteResult): number {
  if (suite.total === 0) return 0;
  return suite.passed / suite.total;
}

export interface ScoreInputs {
  publicAfterPatch: TestSuiteResult;
  hidden: TestSuiteResult;
  regressionRatio: number; // fraction of baseline-passing public tests that still pass
  patchScopeAllowed: boolean;
  runCompletedWithoutErrors: boolean;
}

export function computeScore(inputs: ScoreInputs): ScoreBreakdown {
  const public_behavior = Math.round(suiteRatio(inputs.publicAfterPatch) * SCORE_WEIGHTS.public_behavior);
  const hidden_behavior = Math.round(suiteRatio(inputs.hidden) * SCORE_WEIGHTS.hidden_behavior);
  const regression = Math.round(inputs.regressionRatio * SCORE_WEIGHTS.regression);
  const patch_integrity_and_scope = inputs.patchScopeAllowed ? SCORE_WEIGHTS.patch_integrity_and_scope : 0;
  const reproducible_evidence = inputs.runCompletedWithoutErrors ? SCORE_WEIGHTS.reproducible_evidence : 0;

  const total =
    public_behavior + hidden_behavior + regression + patch_integrity_and_scope + reproducible_evidence;

  return {
    public_behavior,
    hidden_behavior,
    regression,
    patch_integrity_and_scope,
    reproducible_evidence,
    total,
  };
}
