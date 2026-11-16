/**
 * S6 key metrics per variant column (UI-S4S6S7). Pure: no React, no network.
 * The artboard "S6 Experiment result: base vs variant" opens with a Key metrics block: one value per variant over the
 * whole dataset. Every number here is derived from the uploaded runs of the matrix; cost, tokens and wall time are not
 * in GET /eval-runs, so they have no row (the page says so).
 */
import type { EvalRun } from '../lib/api/types'
import type { Interval } from '../tma/detail'
import { cellStats, verdictOf, type Matrix } from './experiment-matrix'

export interface VariantTotals {
  /** Every repeat of the variant over the dataset, infra failures included. */
  n: number
  infra: number
  counted: number
  pass: number
  passRate: number | null
  interval: Interval | null
  meanScore: number | null
  /** Cases the variant has runs on. */
  cases: number
}

export interface VersusBase {
  /** Cases where this variant is compared with a different baseline variant of the case. */
  compared: number
  better: number
  worse: number
  /** Compared cases where the case-compare rule gave a tie or no verdict (too few counted runs). */
  undecided: number
  /** Pooled pass rate of the variant minus the pooled pass rate of the baselines, over the compared cases, in points. null when a side has no counted run. */
  pointsDelta: number | null
}

export function variantTotals(m: Matrix, variantId: string): VariantTotals {
  const runs: EvalRun[] = []
  let cases = 0
  for (const c of m.cases) {
    const r = c.cells.get(variantId)
    if (r?.length) {
      runs.push(...r)
      cases++
    }
  }
  const s = cellStats(runs)
  return { n: s.n, infra: s.infra, counted: s.counted, pass: s.pass, passRate: s.passRate, interval: s.interval, meanScore: s.meanScore, cases }
}

/** The variant against the baseline of each case it shares with one. A baseline column has no such row (compared = 0). */
export function versusBase(m: Matrix, variantId: string): VersusBase {
  let compared = 0
  let better = 0
  let worse = 0
  let undecided = 0
  const mine: EvalRun[] = []
  const theirs: EvalRun[] = []
  for (const c of m.cases) {
    const v = c.cells.get(variantId)
    const b = c.baselineId && c.baselineId !== variantId ? c.cells.get(c.baselineId) : undefined
    if (!v?.length || !b?.length) continue
    compared++
    mine.push(...v)
    theirs.push(...b)
    const label = verdictOf(b, v).label
    if (label === 'better') better++
    else if (label === 'worse') worse++
    else undecided++
  }
  const a = cellStats(mine)
  const z = cellStats(theirs)
  const pointsDelta = a.passRate != null && z.passRate != null ? Math.round((a.passRate - z.passRate) * 100) : null
  return { compared, better, worse, undecided, pointsDelta }
}

/** The index of the best column for a higher-is-better value, or null when fewer than two have one or they all tie. */
export function bestIndex(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v != null)
  if (known.length < 2) return null
  const top = Math.max(...known)
  if (known.every((v) => v === top)) return null
  const at = values.map((v, i) => (v === top ? i : -1)).filter((i) => i >= 0)
  return at.length === 1 ? at[0]! : null
}

/** Pass rate text for the totals: `62% (25 of 40)`. */
export const rateOf = (t: Pick<VariantTotals, 'passRate'>) => (t.passRate == null ? null : Math.round(t.passRate * 100))

