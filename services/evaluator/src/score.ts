import type { Score, ScoreBreakdown, TestSuiteResult } from './types.js';

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

export type ScorerName = keyof typeof SCORE_WEIGHTS;

function suiteRatio(suite: TestSuiteResult): number {
  if (suite.total === 0) return 0;
  return suite.passed / suite.total;
}

/** A suite measured something only when its report was trusted (see suite.ts interpretRun). */
function measured(suite: TestSuiteResult): boolean {
  return (suite.state === undefined || suite.state === 'ok') && suite.total > 0;
}

export interface ScoreInputs {
  publicAfterPatch: TestSuiteResult;
  hidden: TestSuiteResult;
  regressionRatio: number; // fraction of baseline-passing public tests that still pass
  patchScopeAllowed: boolean;
  runCompletedWithoutErrors: boolean;
}

/**
 * A Scorer (Inspect AI vocabulary): a named, weighted grader that turns the grading inputs into
 * one Score. All five run in the trusted plane (the worker), never in a grading container.
 */
export interface Scorer {
  name: ScorerName;
  weight: number;
  score(inputs: ScoreInputs): Score;
}

const ratioScore = (weight: number, suite: TestSuiteResult, what: string): Score =>
  measured(suite)
    ? {
        value: Math.round(suiteRatio(suite) * weight),
        answer: `${suite.passed}/${suite.total}`,
        explanation: `${suite.passed} of ${suite.total} ${what} pass`,
        metadata: { weight },
      }
    : { value: null, explanation: `unscored: the ${what} were not measured (${suite.state ?? 'no tests'})`, metadata: { weight } };

export const SCORERS: readonly Scorer[] = [
  {
    name: 'public_behavior',
    weight: SCORE_WEIGHTS.public_behavior,
    score: (i) => ratioScore(SCORE_WEIGHTS.public_behavior, i.publicAfterPatch, 'public tests after the patch'),
  },
  {
    name: 'hidden_behavior',
    weight: SCORE_WEIGHTS.hidden_behavior,
    score: (i) => ratioScore(SCORE_WEIGHTS.hidden_behavior, i.hidden, 'hidden tests'),
  },
  {
    name: 'regression',
    weight: SCORE_WEIGHTS.regression,
    score: (i) =>
      measured(i.publicAfterPatch)
        ? {
            value: Math.round(i.regressionRatio * SCORE_WEIGHTS.regression),
            explanation: `${Math.round(i.regressionRatio * 100)} % of the public tests that passed on the baseline still pass`,
            metadata: { weight: SCORE_WEIGHTS.regression },
          }
        : { value: null, explanation: 'unscored: the public tests after the patch were not measured', metadata: { weight: SCORE_WEIGHTS.regression } },
  },
  {
    name: 'patch_integrity_and_scope',
    weight: SCORE_WEIGHTS.patch_integrity_and_scope,
    score: (i) => ({
      value: i.patchScopeAllowed ? SCORE_WEIGHTS.patch_integrity_and_scope : 0,
      explanation: i.patchScopeAllowed ? 'the patch stays inside editable_paths' : 'the patch touches a protected or non-editable path: the run is invalid',
      metadata: { weight: SCORE_WEIGHTS.patch_integrity_and_scope },
    }),
  },
  {
    name: 'reproducible_evidence',
    weight: SCORE_WEIGHTS.reproducible_evidence,
    score: (i) => ({
      value: i.runCompletedWithoutErrors ? SCORE_WEIGHTS.reproducible_evidence : 0,
      explanation: i.runCompletedWithoutErrors ? 'grading completed without errors' : 'grading recorded errors',
      metadata: { weight: SCORE_WEIGHTS.reproducible_evidence },
    }),
  },
];

/** Run every scorer. A Score with value null is UNSCORED, never zero. */
export function runScorers(inputs: ScoreInputs): Record<ScorerName, Score> {
  return Object.fromEntries(SCORERS.map((s) => [s.name, s.score(inputs)])) as Record<ScorerName, Score>;
}

/** The legacy `score` block of the manifest (points per component + total). Unchanged numbers. */
export function computeScore(inputs: ScoreInputs): ScoreBreakdown {
  const public_behavior = Math.round(suiteRatio(inputs.publicAfterPatch) * SCORE_WEIGHTS.public_behavior);
  const hidden_behavior = Math.round(suiteRatio(inputs.hidden) * SCORE_WEIGHTS.hidden_behavior);
  const regression = Math.round(inputs.regressionRatio * SCORE_WEIGHTS.regression);
  const patch_integrity_and_scope = inputs.patchScopeAllowed ? SCORE_WEIGHTS.patch_integrity_and_scope : 0;
  const reproducible_evidence = inputs.runCompletedWithoutErrors ? SCORE_WEIGHTS.reproducible_evidence : 0;

  // A scope violation isn't a 10-point deduction — the agent_prompt tells every agent a change
  // under tests/ "will be rejected". Zeroing only patch_integrity_and_scope while still paying
  // out the other 90 points would let a patch that edits its own grader still score well. The
  // per-component breakdown stays visible in the manifest for diagnostics; only the total reflects
  // the rejection, and the run is still attested (public proof that the agent cheated).
  const total = inputs.patchScopeAllowed
    ? public_behavior + hidden_behavior + regression + patch_integrity_and_scope + reproducible_evidence
    : 0;

  return {
    public_behavior,
    hidden_behavior,
    regression,
    patch_integrity_and_scope,
    reproducible_evidence,
    total,
  };
}
