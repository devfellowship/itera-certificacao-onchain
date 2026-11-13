/** Types and calls of the grader library (S10, S10a; plan 20261112-tma-c5-studio-area-web2, C5-T5). Read only. */
import { ApiError, request } from '../lib/api'

export interface GraderVersionItem {
  id: string
  graderId: string
  semver: string
  kind: 'code' | 'judge' | 'human'
  codeSha256: string
  judgeModelId: string | null
  createdAt: string
  usedByCount: number
}

export interface GraderVersionDetail extends GraderVersionItem {
  rubricSha256: string | null
  paramsSha256: string | null
  testSplitSha256: string | null
  tpr: number | null
  tnr: number | null
  proof: { caught: number; total: number } | null
  calibration: { nLabels: number; nTest: number; tp: number; fn: number; tn: number; fp: number; realignedAt: string | null } | null
  note: string | null
  author: string | null
  recentRuns: Array<{ runId: string; caseId: string | null; evaluationId: string | null; pass: boolean; gradedAt: string }>
}

export type Loaded<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'unavailable' } | { state: 'not-found' } | { state: 'error'; message: string }

export const listGraderVersions = () => request<{ graderVersions: GraderVersionItem[] }>('/grader-versions')
export const getGraderVersion = (id: string) => request<GraderVersionDetail>(`/grader-versions/${encodeURIComponent(id)}`)

/** Maps a failed call to a page state: 503 schema_not_ready is "unavailable" (an empty state), 404 is "not-found". */
export function failedState(e: unknown): Loaded<never> {
  if (e instanceof ApiError && e.status === 503) return { state: 'unavailable' }
  if (e instanceof ApiError && e.status === 404) return { state: 'not-found' }
  return { state: 'error', message: e instanceof Error ? e.message : 'Request failed.' }
}

/** First 12 hex of a digest. */
export const shortDigest = (sha: string) => sha.slice(0, 12)

/**
 * The copy command of a grader version. The eval kit has no command that "runs a grader" alone: a grader belongs to
 * a case, and `tma eval grade --case <case dir>` grades again with the case graders (services/runner GRADE_USAGE).
 * `<case dir>` is the folder made by `tma eval case`.
 */
export const gradeCommand = () => 'tma eval grade --case <case dir> --variant-dir <variant dir>'
