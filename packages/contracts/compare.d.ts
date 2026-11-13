// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
/** The ONE compare library (plan 20261112-tma-c7-model-comparison-per-use-case, ADR-7). See compare.js. */

// ---- Part 1: the per-case rule (C5-T7) ----

export interface CaseRun {
  /** The case score of the run, 0..100. */
  score: number;
  /** True when every hard gate of the case held in this run. */
  hardGatesOk: boolean;
  /** False when the run failed for a platform reason (rate limit, lost runner). Default true. */
  infraOk?: boolean;
}

export declare const MIN_RUNS_PER_SIDE: number;
export declare const RELATIVE_MARGIN: number;
export declare const RELATIVE_ALPHA: number;
export declare const ABSOLUTE_SAME_MIN: number;
export declare const ABSOLUTE_CLOSE_MIN: number;
/** Up to this many runs on both sides together, the p value is exact. */
export declare const EXACT_MAX_RUNS: number;
export declare const ABSOLUTE_RULE_TEXT: string;
export declare const RELATIVE_RULE_TEXT: string;

export type AbsoluteLabel = 'SAME' | 'CLOSE' | 'NOT YET' | 'refused';
/** `tie` is the "relative same" of the C7 plan. */
export type RelativeLabel = 'better' | 'worse' | 'tie' | 'refused';

export interface AbsoluteOptions {
  /** The SAME bar (default 95). */
  same?: number;
  /** The CLOSE bar (default 85). */
  close?: number;
  /** The minimum counted runs (default 5). */
  minRuns?: number;
}
export interface RelativeOptions {
  /** The margin in points (default 5). */
  margin?: number;
  /** The minimum counted runs per side (default 5). */
  minRuns?: number;
}

export interface AbsoluteSide {
  label: AbsoluteLabel;
  /** Why: `n_below_minimum` for a refused side; null otherwise. */
  reason: 'n_below_minimum' | null;
  /** Counted runs (platform faults excluded). */
  n: number;
  infraExcluded: number;
  hardGateFailures: number;
  /** The lowest raw score of the counted runs, or null when n is 0. */
  minScore: number | null;
  runsAtLeastSame: number;
  runsAtLeastClose: number;
}

export interface MannWhitneyResult {
  /** U of the variant side: the number of (variant, base) pairs where the variant wins, ties count 0.5. */
  u: number;
  p: number;
  method: 'exact' | 'normal';
}

export interface RelativeVerdict {
  label: RelativeLabel;
  /** `is_current_agent` / `no_current_agent` only come from compareUseCase. */
  reason: 'n_below_minimum' | 'gap_below_margin' | 'not_significant' | 'is_current_agent' | 'no_current_agent' | null;
  nBase: number;
  nVariant: number;
  /** Means of the effective scores (a failed hard gate scores 0), or null when a side has no run. */
  meanBase: number | null;
  meanVariant: number | null;
  /** meanVariant - meanBase, or null. */
  gap: number | null;
  margin: number;
  alpha: number;
  test: 'mann-whitney-u';
  /** The test result, or null when the rule refused. */
  mannWhitney: MannWhitneyResult | null;
}

export interface CaseComparison {
  /** Both rules, side by side. There is no combined verdict: a person picks (Q-T22 = C). */
  absolute: { base: AbsoluteSide; variant: AbsoluteSide; ruleText: string };
  relative: RelativeVerdict & { ruleText: string };
}

export declare function absoluteRuleText(o?: AbsoluteOptions): string;
export declare function relativeRuleText(o?: RelativeOptions): string;
export declare function absoluteVerdict(runs: ReadonlyArray<CaseRun>, o?: AbsoluteOptions): AbsoluteSide;
export declare function relativeVerdict(
  baseRuns: ReadonlyArray<CaseRun>,
  variantRuns: ReadonlyArray<CaseRun>,
  o?: RelativeOptions,
): RelativeVerdict;
/**
 * Two-sided Mann-Whitney U test of `variant` against `base`, with mid-ranks for ties.
 * Exact when base.length + variant.length <= EXACT_MAX_RUNS, else the normal approximation.
 */
export declare function mannWhitneyU(base: ReadonlyArray<number>, variant: ReadonlyArray<number>): MannWhitneyResult;
/** Compare the base and the variant runs of one case under both rules. */
export declare function compareCase(baseRuns: ReadonlyArray<CaseRun>, variantRuns: ReadonlyArray<CaseRun>): CaseComparison;

// ---- Part 2: per use case (C7-T2) ----

export interface GraderRow {
  graderId: string;
  kind: 'code' | 'judge' | 'human' | (string & {});
  pass: boolean;
  /** The weight the run used (a case override). Null: the profile weight. */
  weight?: number | null;
  hardGate?: boolean | null;
  /** A judge counts only when decisive === true. */
  decisive?: boolean | null;
}

export interface UseCaseRun {
  runId: string;
  agentKey: string;
  caseKey: string;
  /** False: a platform fault, left out of every number and counted as infraExcluded. */
  infraOk?: boolean;
  costUsd?: number | null;
  costSource?: 'metered' | 'derived' | null;
  wallMs?: number | null;
  graders: GraderRow[];
}

export interface ProfileGrader {
  id: string;
  weight: number;
  hardGate: boolean;
}

export interface UseCaseProfile {
  useCase: string;
  graders: ProfileGrader[];
  /** Default 5. */
  minRunsPerCell?: number;
  /** Default 5. */
  relativeMarginPoints?: number;
  /** Default { same: 95, close: 85 }. */
  absoluteBars?: { same: number; close: number };
}

export interface ResolvedUseCaseProfile {
  useCase: string;
  graders: ProfileGrader[];
  minRunsPerCell: number;
  relativeMarginPoints: number;
  absoluteBars: { same: number; close: number };
}

export type IgnoreReason = 'human_label' | 'judge_not_decisive' | 'unknown_kind' | 'no_weight';

export interface RunScore {
  /** 0..100, or null when no grader counted. */
  score: number | null;
  hardGateOk: boolean;
  /** The counted rows, with the resolved weight and hardGate. */
  counted: GraderRow[];
  ignored: { graderId: string; why: IgnoreReason }[];
}

export interface ScoreDistribution {
  min: number;
  /** Quantiles by linear interpolation between closest ranks (Hyndman-Fan type 7). */
  p10: number;
  p50: number;
  p90: number;
  max: number;
}

export interface ParetoStatus {
  /** n >= 1, no hard-gate failure, and a cost per task. */
  eligible: boolean;
  ineligibleReason: null | 'hard_gate_failure' | 'no_cost' | 'no_runs';
  /** Eligible and not dominated; null when ineligible. */
  onFront: boolean | null;
  /** Reported only for an eligible cell with n >= minRunsPerCell (ADR-34); else null. */
  dominated: boolean | null;
}

export interface UseCaseAgentCell {
  agentKey: string;
  /** Counted runs: infraOk !== false and a score. */
  n: number;
  infraExcluded: number;
  noScoreRuns: number;
  hardGateFailures: number;
  /** The score of each counted run, in input order. */
  scores: number[];
  meanScore: number | null;
  distribution: ScoreDistribution | null;
  /** The mean costUsd of the counted runs; null when any counted run lacks a cost. */
  costPerTask: number | null;
  costLabel: 'metered' | 'derived' | null;
  medianWallMs: number | null;
  absolute: AbsoluteSide;
  /** This agent (variant) against the current agent (base). `tie` is the "relative same" of the C7 plan. */
  relative: RelativeVerdict;
  pareto: ParetoStatus;
}

export interface UseCaseComparison {
  useCase: string;
  profile: ResolvedUseCaseProfile;
  /** Sorted by agentKey. */
  agents: UseCaseAgentCell[];
  ruleText: { absolute: string; relative: string };
}

export declare const DEFAULT_MIN_RUNS_PER_CELL: number;
export declare const DEFAULT_RELATIVE_MARGIN_POINTS: number;
export declare function quantile(sorted: number[], q: number): number;
export declare function runScore(run: UseCaseRun, profile: UseCaseProfile): RunScore;
export declare function compareUseCase(
  runs: ReadonlyArray<UseCaseRun>,
  profile: UseCaseProfile,
  opts: { currentAgentKey: string | null },
): UseCaseComparison;
