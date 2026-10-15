import type { Score, ScoreBreakdown, ScoreRule, TestSuiteResult } from './types.js';

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

/**
 * The legacy `score` block of the manifest (points per component + their sum). Score version 1.
 * Since score version 2 (TMA-QC = B) the sum is NOT the platform score: it stays in
 * `score_rule.legacy_total` for diagnostics, and `score.total` comes from hiddenRatioScore().
 */
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

/**
 * Score version. 1 = the sum of the five parts (score_100). 2 = the hidden ratio × 100 when every
 * gate holds, else 0 (TMA-QC = B, TG 21519). Stored on every new EvalLog as `score_version`, so an
 * old score and a new score stay distinguishable. A log without the key is version 1.
 */
export const SCORE_VERSION = 2 as const;
export const SCORE_FORMULA = 'hidden_ratio_x100_gated' as const;

export interface ScoreGateInputs {
  hidden: TestSuiteResult;
  /** The agent changed nothing: a no-op earns no point. */
  patchEmpty: boolean;
  /** Safety gate: the patch stays inside editable_paths (a violation is INVALID). */
  patchScopeAllowed: boolean;
  /** ADR-11: every final-state assertion holds on every scored MCP server. null = the task scores no MCP state. */
  mcpStateHolds: boolean | null;
  /** The v1 total, kept for diagnostics. */
  legacyTotal: number;
}

/**
 * Score version 2: `round(hidden.passed / hidden.total × 100)` when every gate holds, else 0.
 * Public tests, regression, scope and evidence no longer pay points: on an output-only task they
 * came free, so a timeout with 1/13 hidden checks scored 77 (K7 run 63cf78c2). They stay in the
 * `score` block as diagnostics. An unmeasured hidden suite (0 tests or an untrusted report) scores
 * 0 here; the runner then classifies the run as infra_error (unscored), as before.
 * The runner adds one more gate that only it can see: the agent finished inside its wall and cost
 * cap (`agent_finished`, see services/runner/src/outcome.ts applyRunGates).
 */
export function hiddenRatioScore(i: ScoreGateInputs): { total: number; rule: ScoreRule } {
  const hiddenMeasured = measured(i.hidden);
  const gates: ScoreRule['gates'] = {
    hidden_measured: hiddenMeasured,
    patch_nonempty: !i.patchEmpty,
    patch_scope: i.patchScopeAllowed,
    mcp_state: i.mcpStateHolds,
  };
  const hold = Object.values(gates).every((g) => g !== false);
  const total = hold ? Math.round(suiteRatio(i.hidden) * 100) : 0;
  return {
    total,
    rule: {
      formula: SCORE_FORMULA,
      hidden: hiddenMeasured ? `${i.hidden.passed}/${i.hidden.total}` : null,
      gates,
      legacy_total: i.legacyTotal,
    },
  };
}
