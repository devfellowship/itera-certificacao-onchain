/**
 * Pure helpers of the result-store fields on the evaluation page (plan 20261112-tma-c4-result-store-trajectory-upload,
 * T6). No I/O, no React. The API adds `case`, `variant`, `graders` and `trajectorySummary` to GET /evaluations/:id and
 * GET /runs/:id only after db/migrations/0023 is applied, and only a v2 upload fills them. Each helper reads
 * defensively and answers null or an empty list when a field is missing or malformed: the page then renders nothing
 * for it. It never shows a placeholder that looks like data.
 */
import type { EvalCaseView, EvalVariantView, GraderRowView, GraderSummaryView, TrajectorySummaryView } from '../../lib/api'
import { fmtScore } from '../../tma/detail'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** `id@semver`: the name of a grader version. */
export const graderRef = (id: string, semver: string): string => `${id}@${semver}`

export interface VariantInfo {
  label: string
  changeKind: string | null
  isBaseline: boolean
  caseKey: string | null
  mode: string | null
  /** Run rows of this evaluation (one evaluation = one variant). */
  n: number
}

/** The variant of an evaluation, or null for a v1 or hosted one (or before 0023). */
export function variantInfoOf(d: { case?: unknown; variant?: unknown; tasks?: unknown[] }): VariantInfo | null {
  const v = isObj(d.variant) ? (d.variant as Partial<EvalVariantView>) : null
  const label = v ? str(v.label) : null
  if (!v || !label) return null
  const c = isObj(d.case) ? (d.case as Partial<EvalCaseView>) : null
  return {
    label,
    changeKind: str(v.changeKind),
    isBaseline: v.isBaseline === true,
    caseKey: c ? str(c.caseKey) : null,
    mode: c ? str(c.mode) : null,
    n: Array.isArray(d.tasks) ? d.tasks.length : 0,
  }
}

export interface GraderSummaryLine {
  key: string
  ref: string
  kind: string | null
  n: number
  pass: number
  meanScore: number | null
  hardGate: boolean
  decisive: boolean
}

/** The grader versions over an evaluation (`graders` of GET /evaluations/:id). Malformed entries are dropped. */
export function graderSummariesOf(list: unknown): GraderSummaryLine[] {
  if (!Array.isArray(list)) return []
  const out: GraderSummaryLine[] = []
  for (const g of list as Array<Partial<GraderSummaryView>>) {
    if (!isObj(g)) continue
    const id = str(g.id)
    const semver = str(g.semver)
    const n = num(g.n)
    if (!id || !semver || n == null) continue
    out.push({
      key: `${graderRef(id, semver)}#${str(g.codeSha256) ?? ''}`,
      ref: graderRef(id, semver),
      kind: str(g.kind),
      n,
      pass: num(g.pass) ?? 0,
      meanScore: num(g.meanScore),
      hardGate: g.hardGate === true,
      decisive: g.decisive === true,
    })
  }
  return out
}

export interface GraderLine {
  key: string
  ref: string
  kind: string | null
  pass: boolean
  score: number | null
  weight: number | null
  hardGate: boolean
  decisive: boolean
  infraOk: boolean | null
  /** false for a grading that a later re-grade of the same grader version replaced. */
  latest: boolean
}

/** The grading rows of one run, oldest first (as the API sends them). A row that a re-grade replaced has `latest: false`. */
export function graderLinesOf(rows: unknown): GraderLine[] {
  if (!Array.isArray(rows)) return []
  const lines: Array<GraderLine & { id: string }> = []
  for (const g of rows as Array<Partial<GraderRowView>>) {
    if (!isObj(g)) continue
    const id = str(g.id)
    const semver = str(g.semver)
    if (!id || !semver || typeof g.pass !== 'boolean') continue
    const code = str(g.codeSha256) ?? ''
    lines.push({
      id: `${graderRef(id, semver)}#${code}`,
      key: `${graderRef(id, semver)}#${code}@${str(g.gradedAt) ?? lines.length}`,
      ref: graderRef(id, semver),
      kind: str(g.kind),
      pass: g.pass,
      score: num(g.score),
      weight: num(g.weight),
      hardGate: g.hardGate === true,
      decisive: g.decisive === true,
      infraOk: typeof g.infraOk === 'boolean' ? g.infraOk : null,
      latest: true,
    })
  }
  const lastOf = new Map<string, number>()
  lines.forEach((l, i) => lastOf.set(l.id, i))
  return lines.map(({ id, ...l }, i) => ({ ...l, latest: lastOf.get(id) === i }))
}

/** `7 steps · first failure at step 4 · 2 timeout, 1 not_found`, or null when the run has no trajectory summary. */
export function trajectoryTextOf(s: unknown): string | null {
  if (!isObj(s)) return null
  const t = s as Partial<TrajectorySummaryView>
  const steps = num(t.steps)
  if (steps == null) return null
  const parts = [`${steps} step${steps === 1 ? '' : 's'}`]
  const first = num(t.firstFailureSeq)
  parts.push(first == null ? 'no failed step' : `first failure at step ${first}`)
  if (isObj(t.errorClasses)) {
    const classes = Object.entries(t.errorClasses)
      .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, c]) => `${c} ${k}`)
    if (classes.length) parts.push(classes.join(', '))
  }
  return parts.join(' · ')
}

export const fmtGraderScore = (n: number | null): string => (n == null ? 'no score' : `${fmtScore(n)}/100`)
