// Thin client for the apps/api surface (see README.md "Workspace" section and
// 03_produto_mvp_72h.pdf for the field names this mirrors). VITE_API_BASE_URL is public by
// construction — everything baked into a Vite build ships in the bundle — so this file only ever
// holds a URL, never a credential. The operator key (needed for /evaluations/*) is typed in by
// the person operating PreparePage/ObservePage and kept only in React state for that session,
// never hardcoded or read from an env var here.

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'https://itera-agent-credentials-api.devfellowship.com').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(res.status, body.error ?? `request failed with status ${res.status}`)
  }
  return res.json() as Promise<T>
}

export interface CreateEvaluationInput {
  idempotencyKey: string
  vendor: { displayName: string }
  agent: { name: string; endpointUrl: string }
  release: { releaseRef: string; declaredConfigDigest?: string }
  task: { id: string; version: string }
}

export interface RunResponse {
  runId: string
  nonce: string
  status: 'pending' | 'pass' | 'fail' | 'invalid' | 'timeout' | 'infra_error'
  task: { id: string; version: string }
}

export function createEvaluation(input: CreateEvaluationInput, operatorKey: string): Promise<RunResponse> {
  return request('/evaluations', {
    method: 'POST',
    headers: { 'x-operator-key': operatorKey },
    body: JSON.stringify(input),
  })
}

export interface ObservedEvent {
  id: string
  requestDigest: string | null
  responseDigest: string | null
  outputArtifactRef: string | null
  mode: 'observed' | 'vendor_declared'
  occurredAt: string
}

export interface RunEventsResponse {
  runId: string
  status: RunResponse['status']
  events: ObservedEvent[]
}

export function getRunEvents(runId: string, operatorKey: string): Promise<RunEventsResponse> {
  return request(`/evaluations/${runId}/events`, { headers: { 'x-operator-key': operatorKey } })
}

export interface CriterionResult {
  requirement: string
  result: string
}

export interface PublishResponse {
  claimManifestId: string
  canonicalDigestSha256: string
  publishedAt: string
}

export function publishEvaluation(
  runId: string,
  input: { criteriaResults: CriterionResult[]; limitations?: string },
  operatorKey: string,
): Promise<PublishResponse> {
  return request(`/evaluations/${runId}/publish`, {
    method: 'POST',
    headers: { 'x-operator-key': operatorKey },
    body: JSON.stringify(input),
  })
}

export interface CredentialResponse {
  claimManifestId: string
  task: string
  release: string
  criteriaResults: CriterionResult[]
  limitations: string | null
  manifestDigestSha256: string | null
  publishedAt: string | null
  registry: {
    network: string
    attestationAddress: string | null
    status: 'not_issued' | 'pending' | 'confirmed' | 'mismatch' | 'expired' | 'closed' | 'unavailable'
  }
}

export function getCredential(id: string): Promise<CredentialResponse> {
  return request(`/credentials/${id}`)
}

export interface VerifyCheck {
  id: string
  status: 'pass' | 'fail' | 'unavailable'
  detail: string
}

export interface VerifyResponse {
  claimManifestId: string
  registryStatus: string
  checks: VerifyCheck[]
}

export function verifyCredential(id: string): Promise<VerifyResponse> {
  return request(`/credentials/${id}/verify`)
}

export function exportCredentialUrl(id: string): string {
  return `${API_BASE_URL}/credentials/${id}/export`
}

export interface EvaluationRequestInput {
  requesterContact: string
  requesterRole?: string
  taskDescription: string
}

export function submitEvaluationRequest(input: EvaluationRequestInput): Promise<{ id: string; status: string }> {
  return request('/evaluation-requests', { method: 'POST', body: JSON.stringify(input) })
}
