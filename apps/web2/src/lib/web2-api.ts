/**
 * Typed calls of the web2 evaluation flow (plan 20261015-testmyagent-web2-client, T9).
 * Every call goes through the session `apiFetch` (bearer token, 401 → re-federation).
 * Graded-only: no quote, no payment, no proof.
 */
import type { ApiErrorBody } from './errors'

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>

export type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; body: ApiErrorBody | null }

export interface Agent {
  id: string
  name: string
  repoFullName: string
  agentPath: string
  model: string
  source?: 'github' | 'sample' | null
}

export interface Task {
  id: string
  slug: string
  name: string
  description: string | null
  runnable: boolean
  estMinutes: number | null
}

export interface Model {
  id: string
  label?: string | null
}

export interface ModelsResponse {
  default: string | null
  models: Model[]
}

export interface StartEvaluationInput {
  agentId: string
  taskIds: string[]
  modelApiKey: string
  modelRelease?: string
}

export interface StartEvaluationResponse {
  evaluationId: string
  runs: Array<{ id: string; taskId: string; seq: number }>
}

export type EvaluationStatus = 'pending' | 'in_progress' | 'graded' | 'failed' | 'review' | 'cancelled' | 'issuing' | 'issued'

export interface EvaluationTaskView {
  runId: string
  seq: number
  taskId: string
  name: string
  slug: string
  stage: string
  status: string
  outcome: 'PASS' | 'FAIL' | 'INVALID' | null
  score: number | null
  testsPassed: number | null
  testsTotal: number | null
}

export interface EvaluationDetail {
  id: string
  shortId: string
  status: EvaluationStatus
  uiState: string
  paymentKind?: string
  createdAt: string
  elapsedMs: number
  agent: { id: string; name: string; repo: string | null; commit: string | null }
  model: { id: string; release: string | null }
  taskCount: number
  tasks: EvaluationTaskView[]
  score: number | null
  counts: { pass: number; fail: number; invalid: number; review: number; cancelled: number; queued: number; running: number }
}

export interface EvaluationListItem {
  id: string
  shortId: string
  agent: { id: string; name: string }
  createdAt: string
  tasks: Array<{ id: string; slug: string; name: string }>
  counts: { pass: number; fail: number; invalid: number }
  score: number | null
  status: EvaluationStatus
}

/** The end states of an evaluation. The page stops polling on these. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['graded', 'failed', 'cancelled', 'review', 'issued'])

async function call<T>(apiFetch: ApiFetch, path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await apiFetch(path, init)
  } catch {
    return { ok: false, status: 0, body: null }
  }
  const body = (await res.json().catch(() => null)) as unknown
  if (res.ok) return { ok: true, status: res.status, body: body as T }
  return { ok: false, status: res.status, body: (body && typeof body === 'object' ? body : null) as ApiErrorBody | null }
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  sampleRepos: (f: ApiFetch) => call<{ agents: string[] }>(f, '/github/sample-repos'),
  myAgents: (f: ApiFetch) => call<{ agents: Agent[] }>(f, '/agents'),
  models: (f: ApiFetch) => call<ModelsResponse>(f, '/models'),
  curatedTasks: (f: ApiFetch) => call<{ tasks: Task[] }>(f, '/tasks?source=curated&runnable=true'),
  /** Registers (or updates, an upsert on repo + path) the caller's copy of a sample agent with the model. */
  registerSampleAgent: (f: ApiFetch, repoFullName: string, model: string) =>
    call<{ agent: Agent }>(
      f,
      '/agents',
      postJson({ repoFullName, agentPath: '.', model, visibility: 'private', source: 'sample', name: repoFullName.split('/').pop() }),
    ),
  startEvaluation: (f: ApiFetch, input: StartEvaluationInput) => call<StartEvaluationResponse>(f, '/evaluations', postJson(input)),
  evaluation: (f: ApiFetch, id: string) => call<EvaluationDetail>(f, `/evaluations/${encodeURIComponent(id)}`),
  cancelEvaluation: (f: ApiFetch, id: string) => call<{ status: string }>(f, `/evaluations/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  myEvaluations: (f: ApiFetch) => call<{ evaluations: EvaluationListItem[] }>(f, '/evaluations?scope=all'),
}
