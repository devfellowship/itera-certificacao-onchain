/**
 * S6 experiment result (plan 20261112-tma-c5-studio-area-web2, task C5-T4). Pure: no React, no network.
 *
 * The matrix is cases x agent variants, derived from the caller's uploaded runs (GET /eval-runs). There is no
 * experiment table: an experiment is the set of runs of one case crossed with one variant.
 *
 * One cell = the repeats of one variant on one case:
 *   - n: every repeat, infra failures included;
 *   - infra: repeats with a platform fault (infraOk === false, or status infra_error). An infra failure is NOT a
 *     fail: it is counted apart and left out of the pass rate, the interval and the mean;
 *   - pass / fail over the counted repeats; the pass rate with a 90 % Wilson interval (wilson90 of tma/detail,
 *     the one Wilson helper of web2; not forked here);
 *   - the mean score over the counted repeats that have a score;
 *   - the origin: verified (every run hosted by TMA), self-declared (every run uploaded), or mixed.
 *
 * The verdict of a variant against the case baseline is the ONE per-case compare rule (tma/compare/case-compare.ts);
 * this file only maps the runs into its input.
 */
import type { EvalRun, EvalVariant } from '../lib/api/types'
import { compareCase, MIN_RUNS_PER_SIDE, type CaseComparison, type CaseRun, type RelativeLabel } from '../tma/compare/case-compare'
import { wilson90, type Interval } from '../tma/detail'

export type CellOrigin = 'verified' | 'self-declared' | 'mixed' | null

export interface CellStats {
  n: number
  infra: number
  counted: number
  pass: number
  fail: number
  /** pass / counted, 0..1, or null when nothing was counted. */
  passRate: number | null
  /** 90 % Wilson interval of the pass rate, 0..100, or null when nothing was counted. */
  interval: Interval | null
  meanScore: number | null
  origin: CellOrigin
  /** The evaluations of the repeats, newest run first. */
  evaluationIds: string[]
}

/** A platform fault: not a fail of the agent. */
export function isInfraFailure(r: Pick<EvalRun, 'infraOk' | 'status'>): boolean {
  return r.infraOk === false || r.status === 'infra_error'
}

function originOf(runs: EvalRun[]): CellOrigin {
  const known = runs.map((r) => r.resultOrigin).filter((o): o is NonNullable<EvalRun['resultOrigin']> => o === 'hosted' || o === 'self_declared')
  if (!known.length) return null
  const hosted = known.filter((o) => o === 'hosted').length
  if (hosted === known.length) return 'verified'
  if (hosted === 0) return 'self-declared'
  return 'mixed'
}

export function cellStats(runs: EvalRun[]): CellStats {
  const infra = runs.filter(isInfraFailure).length
  const counted = runs.filter((r) => !isInfraFailure(r))
  const pass = counted.filter((r) => r.status === 'pass').length
  const scores = counted.map((r) => r.score).filter((s): s is number => typeof s === 'number' && Number.isFinite(s))
  const sorted = runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return {
    n: runs.length,
    infra,
    counted: counted.length,
    pass,
    fail: counted.length - pass,
    passRate: counted.length ? pass / counted.length : null,
    interval: wilson90(pass, counted.length),
    meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    origin: originOf(runs),
    evaluationIds: [...new Set(sorted.map((r) => r.evaluationId).filter((x): x is string => !!x))],
  }
}

/** `67% (90% CI 21–94%)`, or `no counted run` when every repeat was an infra failure. */
export function passRateText(s: Pick<CellStats, 'passRate' | 'interval'>): string {
  if (s.passRate == null || !s.interval) return 'no counted run'
  return `${Math.round(s.passRate * 100)}% (90% CI ${Math.round(s.interval.lo)}–${Math.round(s.interval.hi)}%)`
}

export interface MatrixCase {
  caseId: string
  caseKey: string
  useCaseKey: string
  /** The baseline variant of this case (isBaseline is relative to the case), or null. */
  baselineId: string | null
  /** variant id -> the runs of that variant on this case. */
  cells: Map<string, EvalRun[]>
}

export interface Matrix {
  cases: MatrixCase[]
  /** The columns: every variant that ran on a listed case. Baselines first, then by label. */
  variants: EvalVariant[]
  /** variant id -> true when it is the baseline of at least one case. */
  baselineOf: Set<string>
}

export function buildMatrix(runs: EvalRun[]): Matrix {
  const cases = new Map<string, MatrixCase>()
  const variants = new Map<string, EvalVariant>()
  const baselineOf = new Set<string>()
  for (const r of runs) {
    const c = cases.get(r.caseId) ?? { caseId: r.caseId, caseKey: r.caseKey, useCaseKey: r.useCaseKey, baselineId: null, cells: new Map() }
    if (r.variant.isBaseline) {
      c.baselineId = r.variant.id
      baselineOf.add(r.variant.id)
    }
    const list = c.cells.get(r.variant.id) ?? []
    list.push(r)
    c.cells.set(r.variant.id, list)
    cases.set(r.caseId, c)
    if (!variants.has(r.variant.id)) variants.set(r.variant.id, r.variant)
  }
  const cols = [...variants.values()].sort(
    (a, b) => Number(baselineOf.has(b.id)) - Number(baselineOf.has(a.id)) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  )
  return { cases: [...cases.values()].sort((a, b) => a.caseKey.localeCompare(b.caseKey)), variants: cols, baselineOf }
}

/**
 * The case-compare input of a list of runs. A run with no score is left out (the rule needs a 0..100 score).
 * hardGatesOk: the API value; a run with no grading (null or absent) has no failed hard gate.
 */
export function toCaseRuns(runs: EvalRun[]): CaseRun[] {
  return runs
    .filter((r) => typeof r.score === 'number' && Number.isFinite(r.score) && r.score >= 0 && r.score <= 100)
    .map((r) => ({ score: r.score as number, hardGatesOk: r.hardGatesOk !== false, infraOk: !isInfraFailure(r) }))
}

export interface Verdict {
  label: RelativeLabel
  /** Short words for the badge. */
  text: string
  /** The tooltip: the reason, both rule texts (Q-T22 = C: both rules side by side). */
  title: string
  comparison: CaseComparison
}

const REASON_TEXT: Record<string, string> = {
  n_below_minimum: `fewer than ${MIN_RUNS_PER_SIDE} counted runs on a side`,
  gap_below_margin: 'the means differ by less than the margin',
  not_significant: 'the difference is not significant',
}

/** The verdict of a variant against the case baseline, from case-compare.ts. */
export function verdictOf(baseRuns: EvalRun[], variantRuns: EvalRun[]): Verdict {
  const comparison = compareCase(toCaseRuns(baseRuns), toCaseRuns(variantRuns))
  const rel = comparison.relative
  const text = rel.label === 'refused' ? 'no verdict' : rel.label
  const why = rel.reason ? ` (${REASON_TEXT[rel.reason] ?? rel.reason})` : ''
  const abs = `Absolute: base ${comparison.absolute.base.label}, variant ${comparison.absolute.variant.label}.`
  return { label: rel.label, text, title: `${text}${why}. ${rel.ruleText} ${abs} ${comparison.absolute.ruleText}`, comparison }
}
