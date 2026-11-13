/** Small view helpers shared by S4 and S5 (C5-T3). */
import type { EvalRun } from '../lib/api/types'

export const sha12 = (s: string | null | undefined) => (s ? s.slice(0, 12) : '—')

/** The canonical pages of a run and of an evaluation (routes.tsx: /evaluations/:eid and /evaluations/:eid/runs/:runId). */
export const runHref = (r: Pick<EvalRun, 'id' | 'evaluationId'>) =>
  r.evaluationId ? `/evaluations/${encodeURIComponent(r.evaluationId)}/runs/${encodeURIComponent(r.id)}` : null
export const evaluationHref = (id: string) => `/evaluations/${encodeURIComponent(id)}`

export function statusTone(status: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'pass') return 'success'
  if (status === 'fail') return 'danger'
  if (status === 'infra_error' || status === 'timeout' || status === 'invalid') return 'warning'
  return 'neutral'
}

/** The distinct evaluation ids of a list of runs, in first-seen order. */
export function evaluationIdsOf(runs: EvalRun[]): string[] {
  return [...new Set(runs.map((r) => r.evaluationId).filter((x): x is string => !!x))]
}

/** The change of a variant, in words. */
export function changeText(changeKind: string): string {
  return changeKind === 'none' ? 'base agent unchanged' : `${changeKind} change`
}
