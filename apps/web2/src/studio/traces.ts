/**
 * Trace client of the studio screens S2 (trace picker, /studio/traces) and S3 (trace view, /studio/traces/:sessionId)
 * (plan 20261112-tma-c5-studio-area-web2, task C5-T6).
 *
 * THE single place that builds `tma studio serve` URLs for traces. S2 and S3 read only through this module. Task
 * C5-T12 later switches the source of the traces here (and only here).
 *
 * The base URL is STUDIO_SERVE_URL (VITE_TMA_STUDIO_SERVE_URL). The serve answers `GET /v1/traces` (listTraces /
 * candidateView in services/runner/src/cli/studio/content.ts) and `GET /v1/traces/:session_id[?agent_id=]` (getTrace).
 * The bearer is the web2 session token. The token never goes into an error message or a log.
 *
 * Parent ADR-1: the TMA API client (lib/api) is NOT used here. No trace content, no task summary and no session id
 * ever goes to the TMA API.
 */
import { STUDIO_SERVE_URL } from '../config'
import { sessionBearer } from './GraderDryRunPanel'

/** The task summary of parent ADR-27: max 280 characters per field. */
export interface TaskSummary {
  before: string | null
  expected: string | null
  outcome: string | null
}

export interface PinStatus {
  pin_sha256: string | null
  complete: boolean | null
  missing: string[]
  layer1: boolean | null
}

/** One candidate row (candidateView). */
export interface TraceRow {
  session_id: string | null
  agent_id: string | null
  parent_session_id: string | null
  run_kind: string | null
  identifier: string | null
  task_id: string | null
  executor: string | null
  harness: string | null
  host: string | null
  model: string | null
  l2_class: string | null
  mode: string | null
  why: string | null
  red: boolean | null
  replayable: boolean | null
  pr: unknown
  n_delivering_prs: number | null
  started_at: string | null
  signals: Record<string, boolean | null> | null
  task_summary: TaskSummary | null
  pin: PinStatus | null
  has_trajectory: boolean
}

export interface TraceList {
  source: { selection_day: string; pins: boolean }
  total: number
  offset: number
  limit: number
  rows: TraceRow[]
}

export interface TraceIndex {
  host: string | null
  harness: string | null
  kind: string | null
  first_ts: string | null
  last_ts: string | null
  message_count: number | null
  models: string[]
  state: string | null
}

export interface TraceSpan {
  seq: number | null
  turn_seq: number | null
  ts: string | null
  ts_end: string | null
  dur_ms: number | null
  tool: string | null
  shape: string | null
  intent: string | null
  family: string | null
  target_kind: string | null
  target: string | null
  ok: boolean | null
  retry_of: unknown
  child_run: unknown
  preview: string | null
  bytes_out: number | null
}

export interface TraceRun {
  agent_id: string | null
  parent_agent_id: string | null
  is_subagent: boolean | null
  spawn_depth: number | null
  agent_type: string | null
  description: string | null
  title: string | null
  started_at: string | null
  ended_at: string | null
  duration_s: number | null
  models: string[]
  n_tool_calls: number | null
  errors: number | null
  spans: TraceSpan[]
}

export interface TraceSummary {
  title: string | null
  started_at: string | null
  ended_at: string | null
  duration_s: number | null
  active_s: number | null
  channel: string | null
  models: string[]
  n_runs: number | null
  n_subagent_runs: number | null
  n_tool_calls: number | null
  tool_counts: Record<string, unknown> | null
  intent_counts: Record<string, unknown> | null
  errors: number | null
  outcome_signals: Record<string, unknown> | null
  closure_confidence: string | null
  cost_usd: number | null
  extractor_version: string | null
}

export type FirstFailure = TraceSpan & { agent_id: string | null }

/** One trace (getTrace). */
export interface Trace {
  session_id: string
  agent_id: string | null
  index: TraceIndex
  candidate: TraceRow | null
  pin: PinStatus | null
  task_summary: TaskSummary | null
  summary: TraceSummary | null
  runs: TraceRun[]
  first_failure: FirstFailure | null
}

export interface TraceListQuery {
  limit?: number
  offset?: number
  l2_class?: string | null
  why?: string | null
  mode?: string | null
}

export type TraceErrorKind = 'not_configured' | 'network' | 'http'

/** A failed trace read. `code` is the serve's `{error}` code (never a token). */
export class TraceServeError extends Error {
  readonly kind: TraceErrorKind
  readonly status: number
  readonly code: string | null
  constructor(kind: TraceErrorKind, status = 0, code: string | null = null) {
    super(kind === 'http' ? `trace service answered ${status}${code ? ` (${code})` : ''}` : `trace service ${kind}`)
    this.name = 'TraceServeError'
    this.kind = kind
    this.status = status
    this.code = code
  }
}

export interface TraceFetchOptions {
  /** Override of STUDIO_SERVE_URL (tests). */
  serveUrl?: string
  /** Override of the session bearer (tests). */
  getToken?: () => string | null
  /** Override of the global fetch (tests). */
  fetchImpl?: typeof fetch
}

export const TRACE_PAGE_SIZE = 50

/** `<base>/v1/traces?...`. Empty filters are dropped. */
export function traceListUrl(base: string, q: TraceListQuery): string {
  const p = new URLSearchParams()
  p.set('limit', String(q.limit ?? TRACE_PAGE_SIZE))
  if (q.offset) p.set('offset', String(q.offset))
  for (const k of ['l2_class', 'why', 'mode'] as const) {
    const v = q[k]
    if (v) p.set(k, v)
  }
  return `${base.replace(/\/+$/, '')}/v1/traces?${p.toString()}`
}

/** `<base>/v1/traces/<session>[?agent_id=]`, with the path segment encoded. */
export function traceUrl(base: string, sessionId: string, agentId?: string | null): string {
  const q = agentId ? `?${new URLSearchParams({ agent_id: agentId }).toString()}` : ''
  return `${base.replace(/\/+$/, '')}/v1/traces/${encodeURIComponent(sessionId)}${q}`
}

async function getJson<T>(build: (base: string) => string, opts: TraceFetchOptions): Promise<T> {
  const base = opts.serveUrl ?? STUDIO_SERVE_URL
  if (!base) throw new TraceServeError('not_configured')
  const token = (opts.getToken ?? sessionBearer)()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(build(base), { method: 'GET', headers, credentials: 'omit', cache: 'no-store' })
  } catch {
    throw new TraceServeError('network')
  }
  const body = (await res.json().catch(() => null)) as unknown
  if (!res.ok) {
    const code = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null
    throw new TraceServeError('http', res.status, code)
  }
  if (!body || typeof body !== 'object') throw new TraceServeError('http', res.status, 'bad_body')
  return body as T
}

/** S2: GET <serve>/v1/traces. */
export function fetchTraceList(query: TraceListQuery, opts: TraceFetchOptions = {}): Promise<TraceList> {
  return getJson<TraceList>((b) => traceListUrl(b, query), opts)
}

/** S3: GET <serve>/v1/traces/:sessionId[?agent_id=]. */
export function fetchTrace(sessionId: string, agentId?: string | null, opts: TraceFetchOptions = {}): Promise<Trace> {
  return getJson<Trace>((b) => traceUrl(b, sessionId, agentId), opts)
}

/** The user text of a failed trace read. */
export function traceErrorText(err: unknown): string {
  if (err instanceof TraceServeError) {
    if (err.kind === 'not_configured') return 'The trace service is not configured on this build.'
    if (err.kind === 'network')
      return 'The trace service did not answer. It is reachable only on the private network (tailnet): open this page from a device on the tailnet.'
    if (err.status === 401) return 'Your session ended. Sign in again.'
    if (err.status === 403) return 'Your account may not read fleet traces.'
    if (err.status === 404 && err.code === 'no_trace_selection') return 'No trace selection exists yet.'
    if (err.status === 404) return 'This trace is not in the index, or it has no trajectory file.'
  }
  return 'The trace service could not load this data. Reload the page to try again.'
}

/** A PR link only for an object `pr` whose `url` is a https://github.com/ URL. */
export function prUrl(pr: unknown): string | null {
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return null
  const url = (pr as { url?: unknown }).url
  return typeof url === 'string' && url.startsWith('https://github.com/') ? url : null
}

/** The S3 path of a row: /studio/traces/<session>[?agent_id=]. */
export function traceHref(sessionId: string, agentId?: string | null): string {
  return `/studio/traces/${encodeURIComponent(sessionId)}${agentId ? `?${new URLSearchParams({ agent_id: agentId }).toString()}` : ''}`
}
