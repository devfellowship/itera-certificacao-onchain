/**
 * Typed client for the testmyagent API (plan 20261012-itera-testmyagent-ui-refactor, "API contract").
 * Every screen calls the API through this module. It adds the SIWS session token, parses errors
 * into ApiError, and builds query strings. VITE_API_BASE_URL is public by construction: no secret
 * belongs in apps/web.
 */
import type * as T from './types'

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'https://itera-agent-credentials-api.devfellowship.com').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message)
  }
}

let sessionToken: string | null = null
let onUnauthorized: (() => void) | null = null

/** Set by the session provider after SIWS. */
export function setSessionToken(token: string | null) {
  sessionToken = token
}
export function getSessionToken() {
  return sessionToken
}
/** Called once on any 401 from an authenticated call (the session provider signs out). */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}

type Query = Record<string, string | number | boolean | string[] | undefined | null>

function qs(query?: Query): string {
  if (!query) return ''
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '') continue
    if (Array.isArray(v)) {
      if (v.length) p.set(k, v.join(','))
    } else p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

export async function request<R>(path: string, init: RequestInit & { query?: Query; auth?: boolean } = {}): Promise<R> {
  const { query, auth = true, headers, ...rest } = init
  const h: Record<string, string> = { ...(headers as Record<string, string> | undefined) }
  if (rest.body != null && !(rest.body instanceof FormData)) h['Content-Type'] = 'application/json'
  if (auth && sessionToken) h.Authorization = `Bearer ${sessionToken}`
  const res = await fetch(`${API_BASE_URL}${path}${qs(query)}`, { ...rest, headers: h })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string }
    if (res.status === 401 && auth && sessionToken) onUnauthorized?.()
    throw new ApiError(res.status, body?.error ?? `request failed with status ${res.status}`, body)
  }
  if (res.status === 204) return undefined as R
  return (await res.json()) as R
}

const json = (body: unknown) => JSON.stringify(body)

export const api = {
  // Identity [EXISTING] + /me [NEW]
  authNonce: (wallet: string) => request<T.NonceResponse>('/auth/nonce', { method: 'POST', body: json({ wallet }), auth: false }),
  authVerify: (wallet: string, signature: string) => request<T.VerifyResponse>('/auth/verify', { method: 'POST', body: json({ wallet, signature }), auth: false }),
  authMe: () => request<T.AuthMe>('/auth/me'),
  me: () => request<T.Me>('/me'),
  patchMe: (input: T.PatchMeInput) => request<T.Me>('/me', { method: 'PATCH', body: json(input) }),

  // Catalog
  tasks: (query: T.TasksQuery = {}) => request<T.TasksResponse>('/tasks', { query: { ...query } }),
  tags: (kind?: T.TagKind) => request<T.TagsResponse>('/tags', { query: { kind } }),
  models: () => request<T.ModelsResponse>('/models'),
  modelAccess: (openrouterKey: string) => request<{ accessible: string[] }>('/models/access', { method: 'POST', body: json({ openrouterKey }) }),

  // GitHub [EXISTING] + branches/commits [NEW]
  githubInstallUrl: () => request<{ url: string; state: string }>('/github/install-url'),
  githubInstallations: () => request<{ installations: T.GithubInstallation[] }>('/github/installations'),
  githubRepos: () => request<{ repos: T.GithubRepo[] }>('/github/repos'),
  githubAgentCandidates: (fullName: string) => request<unknown>(`/github/repos/${fullName}/agent-candidates`),
  githubBranches: (fullName: string) => request<{ branches: T.GithubBranch[] }>(`/github/repos/${fullName}/branches`),
  githubCommits: (fullName: string, branch: string, limit = 20) => request<{ commits: T.GithubCommit[] }>(`/github/repos/${fullName}/commits`, { query: { branch, limit } }),

  // Agents
  agentValidate: (input: T.AgentValidateInput) => request<T.AgentValidateResponse>('/agents/validate', { method: 'POST', body: json(input) }),
  createAgent: (input: T.CreateAgentInput) => request<{ agent: T.Agent; version?: T.AgentVersionSummary }>('/agents', { method: 'POST', body: json(input) }),
  agents: () => request<{ agents: T.Agent[] }>('/agents'),
  agent: (id: string) => request<{ agent: T.Agent }>(`/agents/${encodeURIComponent(id)}`),
  refreshAgent: (id: string) => request<{ changed: boolean; agent: T.Agent }>(`/agents/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
  ranking: (query: T.RankingQuery = {}) => request<T.RankingResponse>('/agents/ranking', { query: { scope: query.scope, q: query.q, taskIds: query.taskIds, tag: query.tag } }),
  agentProfile: (id: string) => request<unknown>(`/agents/${encodeURIComponent(id)}/profile`),
  agentMyResults: (id: string) => request<unknown>(`/agents/${encodeURIComponent(id)}/my-results`),

  // Evaluations and payments
  quote: (input: T.QuoteInput) => request<T.Quote>('/evaluations/quote', { method: 'POST', body: json(input) }),
  createEvaluation: (input: T.CreateEvaluationInput) => request<T.CreateEvaluationResponse>('/evaluations', { method: 'POST', body: json(input) }),
  evaluations: (scope: T.EvaluationScope = 'all') => request<T.EvaluationsResponse>('/evaluations', { query: { scope } }),
  evaluation: (id: string) => request<T.EvaluationDetail>(`/evaluations/${encodeURIComponent(id)}`),
  cancelEvaluation: (id: string) => request<{ status: string }>(`/evaluations/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  // Runs [EXISTING]
  run: (id: string) => request<T.Run>(`/runs/${encodeURIComponent(id)}`),
  runStartSignature: (id: string, wireTransactionBase64: string) => request<unknown>(`/runs/${encodeURIComponent(id)}/start-signature`, { method: 'POST', body: json({ wireTransactionBase64 }) }),
  publishRun: (id: string) => request<{ proofHash: string; status: string }>(`/runs/${encodeURIComponent(id)}/publish`, { method: 'POST' }),

  // Public surface (no auth)
  publicEvaluation: (slugOrHash: string) => request<T.PublicEvaluation>(`/public/evaluations/${encodeURIComponent(slugOrHash)}`, { auth: false }),
  publicManifestUrl: (slug: string) => `${API_BASE_URL}/public/evaluations/${encodeURIComponent(slug)}/manifest.json`,
  publicOgUrl: (slug: string) => `${API_BASE_URL}/public/evaluations/${encodeURIComponent(slug)}/og.png`,
  badgeUrl: (slug: string) => `${API_BASE_URL}/b/${encodeURIComponent(slug)}.svg`,

  // My tasks (P7)
  createTask: (input: T.CreateTaskInput) => request<{ task: T.TaskDetail }>('/tasks', { method: 'POST', body: json(input) }),
  patchTask: (id: string, input: Partial<T.CreateTaskInput>) => request<{ task: T.TaskDetail }>(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: json(input) }),
  deleteTask: (id: string) => request<void>(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createTaskVersion: (id: string, input: T.TaskVersionInput) => request<{ version: number; layout: T.TaskLayout }>(`/tasks/${encodeURIComponent(id)}/versions`, { method: 'POST', body: json(input) }),
  validateTask: (id: string) => request<{ validationRunId: string }>(`/tasks/${encodeURIComponent(id)}/validate`, { method: 'POST' }),
  task: (id: string) => request<T.TaskDetail>(`/tasks/${encodeURIComponent(id)}`),
}

/** Solscan devnet link for a transaction (screen 06 is external, never built). */
export function explorerTxUrl(sig: string) {
  return `https://solscan.io/tx/${sig}?cluster=devnet`
}
