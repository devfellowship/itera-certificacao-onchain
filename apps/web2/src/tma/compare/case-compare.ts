/**
 * S6 per-case compare rule (plan 20261112-tma-c5-studio-area-web2, task C5-T7; parent gap G7 and
 * ADR-34 / Q-T22 = C).
 *
 * Compares the runs of a base agent and a variant agent on ONE case. Pure function, no UI.
 *
 * Q-T22 = C: the studio shows BOTH verdict rules side by side and a person picks which one a route
 * cites. So this function returns the inputs and the label of each rule, and it never combines them:
 *
 *   - absolute (the `testmyagent-model-comparison` skill): per side, SAME when every hard gate holds and
 *     every run scores >= 95; CLOSE when every hard gate holds and every run scores >= 85; else NOT YET.
 *   - relative (against the base agent): hard gates first (a run with a failed hard gate scores 0, parent
 *     ADR-18); then the variant is `better` or `worse` only when the gap of the means is at least 5 points
 *     AND a two-sided Mann-Whitney U test gives p < 0.05. Any other result is `tie`.
 *
 * Both rules refuse a verdict when a side has fewer than 5 counted runs. A run with infraOk === false is a
 * platform fault: it is not counted on either rule.
 *
 * The test: Mann-Whitney U (Wilcoxon rank-sum), two-sided, mid-ranks for ties. The p value is exact (the
 * full permutation distribution of the rank sum, with ties) when both sides together hold at most 60
 * runs; above that it is the normal approximation with the tie correction and a continuity correction.
 */

export interface CaseRun {
  /** The case score of the run, 0..100. */
  score: number
  /** True when every hard gate of the case held in this run. */
  hardGatesOk: boolean
  /** False when the run failed for a platform reason (rate limit, lost runner). Default true. */
  infraOk?: boolean
}

export const MIN_RUNS_PER_SIDE = 5
export const RELATIVE_MARGIN = 5
export const RELATIVE_ALPHA = 0.05
export const ABSOLUTE_SAME_MIN = 95
export const ABSOLUTE_CLOSE_MIN = 85
/** Up to this many runs on both sides together, the p value is exact. */
export const EXACT_MAX_RUNS = 60

export const ABSOLUTE_RULE_TEXT =
  `Absolute rule (per agent): SAME when every hard gate holds in every run and every run scores at least ${ABSOLUTE_SAME_MIN}; ` +
  `CLOSE when every hard gate holds in every run and every run scores at least ${ABSOLUTE_CLOSE_MIN}; else NOT YET. ` +
  `No verdict with fewer than ${MIN_RUNS_PER_SIDE} runs. Runs with a platform fault are not counted.`

export const RELATIVE_RULE_TEXT =
  `Relative rule (variant against base): hard gates first, so a run with a failed hard gate scores 0. ` +
  `The variant is better or worse only when the means differ by at least ${RELATIVE_MARGIN} points and a two-sided ` +
  `Mann-Whitney U test gives p < ${RELATIVE_ALPHA}; otherwise it is a tie. No verdict with fewer than ` +
  `${MIN_RUNS_PER_SIDE} runs per side. Runs with a platform fault are not counted.`

export type AbsoluteLabel = 'SAME' | 'CLOSE' | 'NOT YET' | 'refused'
export type RelativeLabel = 'better' | 'worse' | 'tie' | 'refused'

export interface AbsoluteSide {
  label: AbsoluteLabel
  /** Why: `n_below_minimum` for a refused side; null otherwise. */
  reason: 'n_below_minimum' | null
  /** Counted runs (platform faults excluded). */
  n: number
  infraExcluded: number
  hardGateFailures: number
  /** The lowest raw score of the counted runs, or null when n is 0. */
  minScore: number | null
  runsAtLeastSame: number
  runsAtLeastClose: number
}

export interface MannWhitneyResult {
  /** U of the variant side: the number of (variant, base) pairs where the variant wins, ties count 0.5. */
  u: number
  p: number
  method: 'exact' | 'normal'
}

export interface RelativeVerdict {
  label: RelativeLabel
  reason: 'n_below_minimum' | 'gap_below_margin' | 'not_significant' | null
  nBase: number
  nVariant: number
  /** Means of the effective scores (a failed hard gate scores 0), or null when a side has no run. */
  meanBase: number | null
  meanVariant: number | null
  /** meanVariant - meanBase, or null. */
  gap: number | null
  margin: number
  alpha: number
  test: 'mann-whitney-u'
  /** The test result, or null when the rule refused. */
  mannWhitney: MannWhitneyResult | null
}

export interface CaseComparison {
  /** Both rules, side by side. There is no combined verdict: a person picks (Q-T22 = C). */
  absolute: { base: AbsoluteSide; variant: AbsoluteSide; ruleText: string }
  relative: RelativeVerdict & { ruleText: string }
}

function counted(runs: ReadonlyArray<CaseRun>): { runs: CaseRun[]; infraExcluded: number } {
  for (const r of runs) {
    if (!Number.isFinite(r.score) || r.score < 0 || r.score > 100) throw new RangeError(`a run score must be 0..100, got ${r.score}`)
  }
  const kept = runs.filter((r) => r.infraOk !== false)
  return { runs: kept, infraExcluded: runs.length - kept.length }
}

function absoluteSide(runs: ReadonlyArray<CaseRun>): AbsoluteSide {
  const { runs: kept, infraExcluded } = counted(runs)
  const n = kept.length
  const hardGateFailures = kept.filter((r) => !r.hardGatesOk).length
  const runsAtLeastSame = kept.filter((r) => r.score >= ABSOLUTE_SAME_MIN).length
  const runsAtLeastClose = kept.filter((r) => r.score >= ABSOLUTE_CLOSE_MIN).length
  const minScore = n === 0 ? null : Math.min(...kept.map((r) => r.score))
  const base = { n, infraExcluded, hardGateFailures, minScore, runsAtLeastSame, runsAtLeastClose }
  if (n < MIN_RUNS_PER_SIDE) return { label: 'refused', reason: 'n_below_minimum', ...base }
  let label: AbsoluteLabel = 'NOT YET'
  if (hardGateFailures === 0 && runsAtLeastSame === n) label = 'SAME'
  else if (hardGateFailures === 0 && runsAtLeastClose === n) label = 'CLOSE'
  return { label, reason: null, ...base }
}

/** The standard normal CDF (Abramowitz and Stegun 7.1.26, absolute error below 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

/**
 * Two-sided Mann-Whitney U test of `variant` against `base`, with mid-ranks for ties.
 * Exact when base.length + variant.length <= EXACT_MAX_RUNS, else the normal approximation.
 */
export function mannWhitneyU(base: ReadonlyArray<number>, variant: ReadonlyArray<number>): MannWhitneyResult {
  const n1 = base.length
  const n2 = variant.length
  if (n1 === 0 || n2 === 0) throw new RangeError('each side needs at least one value')
  const N = n1 + n2
  const pooled = [...base.map((v) => ({ v, variant: false })), ...variant.map((v) => ({ v, variant: true }))]
  pooled.sort((x, y) => x.v - y.v)
  // Doubled mid-ranks keep every rank an integer: positions lo..hi (1-based) get lo + hi.
  const rank2 = new Array<number>(N)
  const tieSizes: number[] = []
  for (let i = 0; i < N; ) {
    let j = i
    while (j + 1 < N && pooled[j + 1].v === pooled[i].v) j++
    for (let k = i; k <= j; k++) rank2[k] = i + 1 + (j + 1)
    tieSizes.push(j - i + 1)
    i = j + 1
  }
  let w2 = 0
  pooled.forEach((p, i) => {
    if (p.variant) w2 += rank2[i]
  })
  const u = w2 / 2 - (n2 * (n2 + 1)) / 2
  const e2 = n2 * (N + 1) // E[2W] under the null
  const obsDev = Math.abs(w2 - e2)

  if (N <= EXACT_MAX_RUNS) {
    // ways[c][s]: how many subsets of c items have doubled rank sum s. Uniform under the null.
    const maxSum = N * (N + 1)
    let ways: Float64Array[] = Array.from({ length: n2 + 1 }, () => new Float64Array(maxSum + 1))
    ways[0][0] = 1
    for (let i = 0; i < N; i++) {
      const r = rank2[i]
      const next = ways.map((row) => row.slice())
      for (let c = 0; c < Math.min(i + 1, n2); c++) {
        const from = ways[c]
        const to = next[c + 1]
        for (let s = 0; s + r <= maxSum; s++) if (from[s] !== 0) to[s + r] += from[s]
      }
      ways = next
    }
    let total = 0
    let extreme = 0
    const last = ways[n2]
    for (let s = 0; s <= maxSum; s++) {
      if (last[s] === 0) continue
      total += last[s]
      if (Math.abs(s - e2) >= obsDev) extreme += last[s]
    }
    return { u, p: Math.min(1, extreme / total), method: 'exact' }
  }

  const tieTerm = tieSizes.reduce((acc, t) => acc + (t * t * t - t), 0)
  const variance = ((n1 * n2) / 12) * (N + 1 - tieTerm / (N * (N - 1)))
  if (variance <= 0) return { u, p: 1, method: 'normal' }
  const z = Math.max(0, Math.abs(u - (n1 * n2) / 2) - 0.5) / Math.sqrt(variance)
  return { u, p: Math.min(1, 2 * (1 - normalCdf(z))), method: 'normal' }
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
}

function relativeVerdict(baseRuns: ReadonlyArray<CaseRun>, variantRuns: ReadonlyArray<CaseRun>): RelativeVerdict {
  const effective = (runs: CaseRun[]) => runs.map((r) => (r.hardGatesOk ? r.score : 0))
  const b = effective(counted(baseRuns).runs)
  const v = effective(counted(variantRuns).runs)
  const meanBase = mean(b)
  const meanVariant = mean(v)
  const gap = meanBase === null || meanVariant === null ? null : meanVariant - meanBase
  const common = {
    nBase: b.length,
    nVariant: v.length,
    meanBase,
    meanVariant,
    gap,
    margin: RELATIVE_MARGIN,
    alpha: RELATIVE_ALPHA,
    test: 'mann-whitney-u' as const,
  }
  if (b.length < MIN_RUNS_PER_SIDE || v.length < MIN_RUNS_PER_SIDE) {
    return { label: 'refused', reason: 'n_below_minimum', mannWhitney: null, ...common }
  }
  const mw = mannWhitneyU(b, v)
  const g = gap as number
  if (Math.abs(g) < RELATIVE_MARGIN) return { label: 'tie', reason: 'gap_below_margin', mannWhitney: mw, ...common }
  if (mw.p >= RELATIVE_ALPHA) return { label: 'tie', reason: 'not_significant', mannWhitney: mw, ...common }
  return { label: g > 0 ? 'better' : 'worse', reason: null, mannWhitney: mw, ...common }
}

/** Compare the base and the variant runs of one case under both rules. */
export function compareCase(baseRuns: ReadonlyArray<CaseRun>, variantRuns: ReadonlyArray<CaseRun>): CaseComparison {
  return {
    absolute: { base: absoluteSide(baseRuns), variant: absoluteSide(variantRuns), ruleText: ABSOLUTE_RULE_TEXT },
    relative: { ...relativeVerdict(baseRuns, variantRuns), ruleText: RELATIVE_RULE_TEXT },
  }
}
