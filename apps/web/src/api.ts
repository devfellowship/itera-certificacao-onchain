// Thin client for the apps/api surface (see README.md "Workspace" section and
// 03_produto_mvp_72h.pdf for the field names this mirrors). VITE_API_BASE_URL is public by
// construction — everything baked into a Vite build ships in the bundle — so this file only ever
// holds a URL, never a credential. No secret of any kind belongs in this file, or anywhere under
// apps/web: a static SPA build ships verbatim to every visitor's browser, so there is no such
// thing as a "backend-only" value inside it. The vendor-side /evaluations/* routes used to require
// an "operator key" typed into the UI — removed 2026-10-12, self-serve for the hackathon phase (no
// login system exists yet). A future commercial or DFL-internal version gates this behind real
// login+password, server-side — not a client-typed shared secret.

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

export function createEvaluation(input: CreateEvaluationInput): Promise<RunResponse> {
  return request('/evaluations', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

// Sends the challenge to the vendor's endpoint and runs the real grader server-side — can take up
// to ~90s (services/evaluator's own observed range), so this call is slow by design, not a bug.
export function dispatchEvaluation(runId: string): Promise<RunResponse> {
  return request(`/evaluations/${runId}/dispatch`, { method: 'POST' })
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
  scoreTotal: number | null
  evidenceManifest: unknown | null
  events: ObservedEvent[]
}

export function getRunEvents(runId: string): Promise<RunEventsResponse> {
  return request(`/evaluations/${runId}/events`)
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
): Promise<PublishResponse> {
  return request(`/evaluations/${runId}/publish`, {
    method: 'POST',
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

export interface TaskPack {
  id: string
  version: string
}

export function getTaskPacks(): Promise<TaskPack[]> {
  return request('/task-packs')
}

export interface AgentEndpointManifestInput {
  vendorName: string
  agentName: string
  fileName: string
  content: string
}

export interface AgentEndpointManifestResponse {
  commitSha: string
  endpointUrl: string
}

// Commits the uploaded agent-endpoint config file to the public manifests repo (audit trail) and
// returns the endpointUrl extracted from it, for use in createEvaluation.
export function submitAgentEndpointManifest(input: AgentEndpointManifestInput): Promise<AgentEndpointManifestResponse> {
  return request('/agent-endpoint-manifests', { method: 'POST', body: JSON.stringify(input) })
}

export interface EvaluationRequestInput {
  requesterContact: string
  requesterRole?: string
  taskDescription: string
}

export function submitEvaluationRequest(input: EvaluationRequestInput): Promise<{ id: string; status: string }> {
  return request('/evaluation-requests', { method: 'POST', body: JSON.stringify(input) })
}
