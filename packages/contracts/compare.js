// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The ONE compare library of TestMyAgent (plan 20261112-tma-c7-model-comparison-per-use-case, ADR-7). apps/web2 (the
// studio) and apps/api import the same rules from here: there is no second copy of any rule.
//
// Part 1 — the per-case rule (plan 20261112-tma-c5-studio-area-web2, task C5-T7; parent gap G7, ADR-34 / Q-T22 = C).
// Compares the runs of a base agent and a variant agent on ONE case. Q-T22 = C: the studio shows BOTH verdict rules
// side by side and a person picks which one a route cites. So the result holds the inputs and the label of each rule,
// and it never combines them:
//
//   - absolute (the `testmyagent-model-comparison` skill): per side, SAME when every hard gate holds and every run
//     scores >= 95; CLOSE when every hard gate holds and every run scores >= 85; else NOT YET.
//   - relative (against the base agent): hard gates first (a run with a failed hard gate scores 0, parent ADR-18);
//     then the variant is `better` or `worse` only when the gap of the means is at least 5 points AND a two-sided
//     Mann-Whitney U test gives p < 0.05. Any other result is `tie`. (The C7 plan says "relative same": that is the
//     label `tie`.)
//
// Both rules refuse a verdict when a side has fewer than 5 counted runs. A run with infraOk === false is a platform
// fault: it is not counted on either rule. The bars, the margin and the minimum n are parameters; the constants below
// are the defaults.
//
// The test: Mann-Whitney U (Wilcoxon rank-sum), two-sided, mid-ranks for ties. The p value is exact (the full
// permutation distribution of the rank sum, with ties) when both sides together hold at most 60 runs; above that it
// is the normal approximation with the tie correction and a continuity correction.
//
// Part 2 — the per-use-case compare (C7-T2; ADR-2, ADR-4, ADR-8): the run score is a weighted pass rate of binary
// graders, both verdict rules per (use case x agent) cell, and the Pareto set of (mean score, cost per task) after the
// hard gates. Pure: no I/O.

/** @typedef {{ score: number, hardGatesOk: boolean, infraOk?: boolean }} CaseRun */
/** @typedef {'SAME' | 'CLOSE' | 'NOT YET' | 'refused'} AbsoluteLabel */
/** @typedef {'better' | 'worse' | 'tie' | 'refused'} RelativeLabel */
/**
 * @typedef {{ label: AbsoluteLabel, reason: 'n_below_minimum' | null, n: number, infraExcluded: number,
 *   hardGateFailures: number, minScore: number | null, runsAtLeastSame: number, runsAtLeastClose: number }} AbsoluteSide
 */
/** @typedef {{ u: number, p: number, method: 'exact' | 'normal' }} MannWhitneyResult */
/**
 * @typedef {{ label: RelativeLabel,
 *   reason: 'n_below_minimum' | 'gap_below_margin' | 'not_significant' | 'is_current_agent' | 'no_current_agent' | null,
 *   nBase: number, nVariant: number, meanBase: number | null, meanVariant: number | null, gap: number | null,
 *   margin: number, alpha: number, test: 'mann-whitney-u', mannWhitney: MannWhitneyResult | null }} RelativeVerdict
 */
/** @typedef {{ same?: number, close?: number, minRuns?: number }} AbsoluteOptions */
/** @typedef {{ margin?: number, minRuns?: number }} RelativeOptions */

export const MIN_RUNS_PER_SIDE = 5;
export const RELATIVE_MARGIN = 5;
export const RELATIVE_ALPHA = 0.05;
export const ABSOLUTE_SAME_MIN = 95;
export const ABSOLUTE_CLOSE_MIN = 85;
/** Up to this many runs on both sides together, the p value is exact. */
export const EXACT_MAX_RUNS = 60;

/** The absolute rule text for the given bars and minimum n. @param {AbsoluteOptions} [o] */
export function absoluteRuleText(o = {}) {
  const { same = ABSOLUTE_SAME_MIN, close = ABSOLUTE_CLOSE_MIN, minRuns = MIN_RUNS_PER_SIDE } = o;
  return (
    `Absolute rule (per agent): SAME when every hard gate holds in every run and every run scores at least ${same}; ` +
    `CLOSE when every hard gate holds in every run and every run scores at least ${close}; else NOT YET. ` +
    `No verdict with fewer than ${minRuns} runs. Runs with a platform fault are not counted.`
  );
}

/** The relative rule text for the given margin and minimum n. @param {RelativeOptions} [o] */
export function relativeRuleText(o = {}) {
  const { margin = RELATIVE_MARGIN, minRuns = MIN_RUNS_PER_SIDE } = o;
  return (
    `Relative rule (variant against base): hard gates first, so a run with a failed hard gate scores 0. ` +
    `The variant is better or worse only when the means differ by at least ${margin} points and a two-sided ` +
    `Mann-Whitney U test gives p < ${RELATIVE_ALPHA}; otherwise it is a tie. No verdict with fewer than ` +
    `${minRuns} runs per side. Runs with a platform fault are not counted.`
  );
}

export const ABSOLUTE_RULE_TEXT = absoluteRuleText();
export const RELATIVE_RULE_TEXT = relativeRuleText();

/** @param {ReadonlyArray<CaseRun>} runs @returns {{ runs: CaseRun[], infraExcluded: number }} */
function counted(runs) {
  for (const r of runs) {
    if (!Number.isFinite(r.score) || r.score < 0 || r.score > 100) throw new RangeError(`a run score must be 0..100, got ${r.score}`);
  }
  const kept = runs.filter((r) => r.infraOk !== false);
  return { runs: kept, infraExcluded: runs.length - kept.length };
}

/**
 * The absolute rule for one side (one agent). @param {ReadonlyArray<CaseRun>} runs @param {AbsoluteOptions} [o]
 * @returns {AbsoluteSide}
 */
export function absoluteVerdict(runs, o = {}) {
  const { same = ABSOLUTE_SAME_MIN, close = ABSOLUTE_CLOSE_MIN, minRuns = MIN_RUNS_PER_SIDE } = o;
  const { runs: kept, infraExcluded } = counted(runs);
  const n = kept.length;
  const hardGateFailures = kept.filter((r) => !r.hardGatesOk).length;
  const runsAtLeastSame = kept.filter((r) => r.score >= same).length;
  const runsAtLeastClose = kept.filter((r) => r.score >= close).length;
  const minScore = n === 0 ? null : Math.min(...kept.map((r) => r.score));
  const base = { n, infraExcluded, hardGateFailures, minScore, runsAtLeastSame, runsAtLeastClose };
  if (n < minRuns) return { label: 'refused', reason: 'n_below_minimum', ...base };
  /** @type {AbsoluteLabel} */
  let label = 'NOT YET';
  if (hardGateFailures === 0 && runsAtLeastSame === n) label = 'SAME';
  else if (hardGateFailures === 0 && runsAtLeastClose === n) label = 'CLOSE';
  return { label, reason: null, ...base };
}

/** The standard normal CDF (Abramowitz and Stegun 7.1.26, absolute error below 1.5e-7). @param {number} z */
function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * Two-sided Mann-Whitney U test of `variant` against `base`, with mid-ranks for ties.
 * Exact when base.length + variant.length <= EXACT_MAX_RUNS, else the normal approximation.
 * @param {ReadonlyArray<number>} base @param {ReadonlyArray<number>} variant @returns {MannWhitneyResult}
 */
export function mannWhitneyU(base, variant) {
  const n1 = base.length;
  const n2 = variant.length;
  if (n1 === 0 || n2 === 0) throw new RangeError('each side needs at least one value');
  const N = n1 + n2;
  const pooled = [...base.map((v) => ({ v, variant: false })), ...variant.map((v) => ({ v, variant: true }))];
  pooled.sort((x, y) => x.v - y.v);
  // Doubled mid-ranks keep every rank an integer: positions lo..hi (1-based) get lo + hi.
  /** @type {number[]} */
  const rank2 = new Array(N);
  /** @type {number[]} */
  const tieSizes = [];
  for (let i = 0; i < N; ) {
    let j = i;
    while (j + 1 < N && pooled[j + 1].v === pooled[i].v) j++;
    for (let k = i; k <= j; k++) rank2[k] = i + 1 + (j + 1);
    tieSizes.push(j - i + 1);
    i = j + 1;
  }
  let w2 = 0;
  pooled.forEach((p, i) => {
    if (p.variant) w2 += rank2[i];
  });
  const u = w2 / 2 - (n2 * (n2 + 1)) / 2;
  const e2 = n2 * (N + 1); // E[2W] under the null
  const obsDev = Math.abs(w2 - e2);

  if (N <= EXACT_MAX_RUNS) {
    // ways[c][s]: how many subsets of c items have doubled rank sum s. Uniform under the null.
    const maxSum = N * (N + 1);
    let ways = Array.from({ length: n2 + 1 }, () => new Float64Array(maxSum + 1));
    ways[0][0] = 1;
    for (let i = 0; i < N; i++) {
      const r = rank2[i];
      const next = ways.map((row) => row.slice());
      for (let c = 0; c < Math.min(i + 1, n2); c++) {
        const from = ways[c];
        const to = next[c + 1];
        for (let s = 0; s + r <= maxSum; s++) if (from[s] !== 0) to[s + r] += from[s];
      }
      ways = next;
    }
    let total = 0;
    let extreme = 0;
    const last = ways[n2];
    for (let s = 0; s <= maxSum; s++) {
      if (last[s] === 0) continue;
      total += last[s];
      if (Math.abs(s - e2) >= obsDev) extreme += last[s];
    }
    return { u, p: Math.min(1, extreme / total), method: 'exact' };
  }

  const tieTerm = tieSizes.reduce((acc, t) => acc + (t * t * t - t), 0);
  const variance = ((n1 * n2) / 12) * (N + 1 - tieTerm / (N * (N - 1)));
  if (variance <= 0) return { u, p: 1, method: 'normal' };
  const z = Math.max(0, Math.abs(u - (n1 * n2) / 2) - 0.5) / Math.sqrt(variance);
  return { u, p: Math.min(1, 2 * (1 - normalCdf(z))), method: 'normal' };
}

/** @param {number[]} xs @returns {number | null} */
function mean(xs) {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * The relative rule: the variant against the base. Label `tie` is the "relative same" of the C7 plan.
 * @param {ReadonlyArray<CaseRun>} baseRuns @param {ReadonlyArray<CaseRun>} variantRuns @param {RelativeOptions} [o]
 * @returns {RelativeVerdict}
 */
export function relativeVerdict(baseRuns, variantRuns, o = {}) {
  const { margin = RELATIVE_MARGIN, minRuns = MIN_RUNS_PER_SIDE } = o;
  /** @param {CaseRun[]} runs */
  const effective = (runs) => runs.map((r) => (r.hardGatesOk ? r.score : 0));
  const b = effective(counted(baseRuns).runs);
  const v = effective(counted(variantRuns).runs);
  const meanBase = mean(b);
  const meanVariant = mean(v);
  const gap = meanBase === null || meanVariant === null ? null : meanVariant - meanBase;
  const common = {
    nBase: b.length,
    nVariant: v.length,
    meanBase,
    meanVariant,
    gap,
    margin,
    alpha: RELATIVE_ALPHA,
    test: /** @type {const} */ ('mann-whitney-u'),
  };
  if (b.length < minRuns || v.length < minRuns) {
    return { label: 'refused', reason: 'n_below_minimum', mannWhitney: null, ...common };
  }
  const mw = mannWhitneyU(b, v);
  const g = /** @type {number} */ (gap);
  if (Math.abs(g) < margin) return { label: 'tie', reason: 'gap_below_margin', mannWhitney: mw, ...common };
  if (mw.p >= RELATIVE_ALPHA) return { label: 'tie', reason: 'not_significant', mannWhitney: mw, ...common };
  return { label: g > 0 ? 'better' : 'worse', reason: null, mannWhitney: mw, ...common };
}

/**
 * Compare the base and the variant runs of one case under both rules (default bars, margin and minimum n).
 * @param {ReadonlyArray<CaseRun>} baseRuns @param {ReadonlyArray<CaseRun>} variantRuns
 */
export function compareCase(baseRuns, variantRuns) {
  return {
    absolute: { base: absoluteVerdict(baseRuns), variant: absoluteVerdict(variantRuns), ruleText: ABSOLUTE_RULE_TEXT },
    relative: { ...relativeVerdict(baseRuns, variantRuns), ruleText: RELATIVE_RULE_TEXT },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Part 2 — per use case (C7-T2).

/**
 * @typedef {{ graderId: string, kind: string, pass: boolean, weight?: number | null, hardGate?: boolean | null,
 *   decisive?: boolean | null }} GraderRow
 */
/**
 * @typedef {{ runId: string, agentKey: string, caseKey: string, infraOk?: boolean, costUsd?: number | null,
 *   costSource?: 'metered' | 'derived' | null, wallMs?: number | null, graders: GraderRow[] }} UseCaseRun
 */
/** @typedef {{ id: string, weight: number, hardGate: boolean }} ProfileGrader */
/**
 * @typedef {{ useCase: string, graders: ProfileGrader[], minRunsPerCell?: number, relativeMarginPoints?: number,
 *   absoluteBars?: { same: number, close: number } }} UseCaseProfile
 */
/**
 * @typedef {{ useCase: string, graders: ProfileGrader[], minRunsPerCell: number, relativeMarginPoints: number,
 *   absoluteBars: { same: number, close: number } }} ResolvedProfile
 */
/** @typedef {'human_label' | 'judge_not_decisive' | 'unknown_kind' | 'no_weight'} IgnoreReason */

export const DEFAULT_MIN_RUNS_PER_CELL = MIN_RUNS_PER_SIDE;
export const DEFAULT_RELATIVE_MARGIN_POINTS = RELATIVE_MARGIN;

/** @param {UseCaseProfile} profile @returns {ResolvedProfile} */
function resolveProfile(profile) {
  const minRunsPerCell = profile.minRunsPerCell ?? DEFAULT_MIN_RUNS_PER_CELL;
  const relativeMarginPoints = profile.relativeMarginPoints ?? DEFAULT_RELATIVE_MARGIN_POINTS;
  const absoluteBars = { same: profile.absoluteBars?.same ?? ABSOLUTE_SAME_MIN, close: profile.absoluteBars?.close ?? ABSOLUTE_CLOSE_MIN };
  if (!Number.isInteger(minRunsPerCell) || minRunsPerCell < 1) throw new RangeError(`minRunsPerCell must be an integer >= 1, got ${minRunsPerCell}`);
  if (!Number.isFinite(relativeMarginPoints) || relativeMarginPoints < 0 || relativeMarginPoints > 100) {
    throw new RangeError(`relativeMarginPoints must be 0..100, got ${relativeMarginPoints}`);
  }
  for (const [k, v] of Object.entries(absoluteBars)) {
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new RangeError(`absoluteBars.${k} must be 0..100, got ${v}`);
  }
  for (const g of profile.graders) {
    if (!Number.isFinite(g.weight) || g.weight <= 0) throw new RangeError(`the weight of grader ${g.id} must be > 0, got ${g.weight}`);
  }
  return { useCase: profile.useCase, graders: profile.graders.map((g) => ({ ...g })), minRunsPerCell, relativeMarginPoints, absoluteBars };
}

/**
 * The score of one run (Q-T10 = A, ADR-2): a weighted pass rate of binary graders, 0..100.
 *   - counted graders: kind `code`, and kind `judge` only when `decisive === true`. A non-decisive judge is a side
 *     signal and a `human` row is a label: both are listed in `ignored`, never scored.
 *   - weight: the row weight when set (the weight the run used, for example a case override), else the profile weight.
 *     A grader with neither is ignored (`no_weight`). A weight <= 0 throws a RangeError.
 *   - hard gate: the row value when set, else the profile value. Any failed hard gate makes the score 0.
 *   - no counted grader: score null (the caller leaves the run out and counts it as `noScoreRuns`).
 * @param {UseCaseRun} run @param {UseCaseProfile} profile
 * @returns {{ score: number | null, hardGateOk: boolean, counted: GraderRow[], ignored: { graderId: string, why: IgnoreReason }[] }}
 */
export function runScore(run, profile) {
  const byId = new Map(profile.graders.map((g) => [g.id, g]));
  /** @type {GraderRow[]} */
  const countedRows = [];
  /** @type {{ graderId: string, why: IgnoreReason }[]} */
  const ignored = [];
  let total = 0;
  let passed = 0;
  let hardGateOk = true;
  for (const row of run.graders) {
    if (row.kind === 'human') { ignored.push({ graderId: row.graderId, why: 'human_label' }); continue; }
    if (row.kind === 'judge' && row.decisive !== true) { ignored.push({ graderId: row.graderId, why: 'judge_not_decisive' }); continue; }
    if (row.kind !== 'code' && row.kind !== 'judge') { ignored.push({ graderId: row.graderId, why: 'unknown_kind' }); continue; }
    const p = byId.get(row.graderId);
    const weight = row.weight ?? p?.weight;
    if (weight === undefined || weight === null) { ignored.push({ graderId: row.graderId, why: 'no_weight' }); continue; }
    if (!Number.isFinite(weight) || weight <= 0) throw new RangeError(`the weight of grader ${row.graderId} must be > 0, got ${weight}`);
    const hardGate = row.hardGate ?? p?.hardGate ?? false;
    countedRows.push({ ...row, weight, hardGate });
    total += weight;
    if (row.pass) passed += weight;
    else if (hardGate) hardGateOk = false;
  }
  if (countedRows.length === 0) return { score: null, hardGateOk, counted: countedRows, ignored };
  const score = hardGateOk ? (100 * passed) / total : 0; // a failed hard gate scores 0 (parent ADR-18)
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new RangeError(`a run score must be 0..100, got ${score}`);
  return { score, hardGateOk, counted: countedRows, ignored };
}

/**
 * A quantile of sorted values, by linear interpolation between closest ranks (Hyndman-Fan type 7, the default of R
 * and numpy): h = (n - 1) * q, the value is x[floor h] + (h - floor h) * (x[floor h + 1] - x[floor h]).
 * @param {number[]} sorted @param {number} q
 */
export function quantile(sorted, q) {
  if (sorted.length === 0) throw new RangeError('quantile of no values');
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** @param {number[]} xs @returns {number | null} */
function median(xs) {
  return xs.length === 0 ? null : quantile([...xs].sort((a, b) => a - b), 0.5);
}

/**
 * Compare the agents of one use case: one cell per agent, both verdict rules, and the Pareto set. Pure.
 * @param {ReadonlyArray<UseCaseRun>} runs @param {UseCaseProfile} profile @param {{ currentAgentKey: string | null }} opts
 */
export function compareUseCase(runs, profile, opts) {
  const p = resolveProfile(profile);
  const absOpts = { same: p.absoluteBars.same, close: p.absoluteBars.close, minRuns: p.minRunsPerCell };
  const relOpts = { margin: p.relativeMarginPoints, minRuns: p.minRunsPerCell };

  /** @type {Map<string, { infraExcluded: number, noScoreRuns: number, kept: { score: number, hardGateOk: boolean, run: UseCaseRun }[] }>} */
  const cells = new Map();
  for (const run of runs) {
    let cell = cells.get(run.agentKey);
    if (!cell) { cell = { infraExcluded: 0, noScoreRuns: 0, kept: [] }; cells.set(run.agentKey, cell); }
    if (run.infraOk === false) { cell.infraExcluded++; continue; }
    const s = runScore(run, profile);
    if (s.score === null) { cell.noScoreRuns++; continue; }
    cell.kept.push({ score: s.score, hardGateOk: s.hardGateOk, run });
  }

  /** @param {string} key @returns {CaseRun[]} */
  const caseRunsOf = (key) => (cells.get(key)?.kept ?? []).map((k) => ({ score: k.score, hardGatesOk: k.hardGateOk }));
  const current = opts.currentAgentKey;

  const agents = [...cells.keys()].sort().map((agentKey) => {
    const cell = /** @type {NonNullable<ReturnType<typeof cells.get>>} */ (cells.get(agentKey));
    const scores = cell.kept.map((k) => k.score);
    const n = scores.length;
    const hardGateFailures = cell.kept.filter((k) => !k.hardGateOk).length;
    const sorted = [...scores].sort((a, b) => a - b);
    const distribution = n === 0 ? null : {
      min: sorted[0], p10: quantile(sorted, 0.1), p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), max: sorted[n - 1],
    };
    const costs = cell.kept.map((k) => k.run.costUsd);
    const allCost = n > 0 && costs.every((c) => typeof c === 'number' && Number.isFinite(c));
    const costPerTask = allCost ? /** @type {number} */ (mean(/** @type {number[]} */ (costs))) : null;
    /** @type {'metered' | 'derived' | null} */
    const costLabel = costPerTask === null ? null : cell.kept.every((k) => k.run.costSource === 'metered') ? 'metered' : 'derived';
    const walls = cell.kept.map((k) => k.run.wallMs).filter((w) => typeof w === 'number' && Number.isFinite(w));
    const medianWallMs = median(/** @type {number[]} */ (walls));

    const own = caseRunsOf(agentKey);
    const absolute = { ...absoluteVerdict(own, absOpts), infraExcluded: cell.infraExcluded };
    /** @type {RelativeVerdict} */
    let relative;
    if (current === null || current === agentKey) {
      const base = current === null ? [] : own;
      relative = {
        ...relativeVerdict(base, own, relOpts),
        label: 'refused',
        reason: current === null ? 'no_current_agent' : 'is_current_agent',
        mannWhitney: null,
      };
    } else {
      relative = relativeVerdict(caseRunsOf(current), own, relOpts);
    }

    /** @type {null | 'hard_gate_failure' | 'no_cost' | 'no_runs'} */
    const ineligibleReason = n === 0 ? 'no_runs' : hardGateFailures > 0 ? 'hard_gate_failure' : costPerTask === null ? 'no_cost' : null;
    return {
      agentKey,
      n,
      infraExcluded: cell.infraExcluded,
      noScoreRuns: cell.noScoreRuns,
      hardGateFailures,
      scores,
      meanScore: mean(scores),
      distribution,
      costPerTask,
      costLabel,
      medianWallMs,
      absolute,
      relative,
      pareto: {
        eligible: ineligibleReason === null,
        ineligibleReason,
        /** @type {boolean | null} */ onFront: null,
        /** @type {boolean | null} */ dominated: null,
      },
    };
  });

  // Pareto after the hard gates: higher mean score is better, lower cost per task is better.
  const eligible = agents.filter((a) => a.pareto.eligible);
  for (const a of eligible) {
    const as = /** @type {number} */ (a.meanScore);
    const ac = /** @type {number} */ (a.costPerTask);
    const isDominated = eligible.some((b) => {
      if (b === a) return false;
      const bs = /** @type {number} */ (b.meanScore);
      const bc = /** @type {number} */ (b.costPerTask);
      return bs >= as && bc <= ac && (bs > as || bc < ac);
    });
    a.pareto.onFront = !isDominated;
    // ADR-34: the "dominated" label only for a full cell.
    a.pareto.dominated = a.n >= p.minRunsPerCell ? isDominated : null;
  }

  return {
    useCase: p.useCase,
    profile: p,
    agents,
    ruleText: {
      absolute: absoluteRuleText(absOpts),
      relative: relativeRuleText(relOpts),
    },
  };
}
