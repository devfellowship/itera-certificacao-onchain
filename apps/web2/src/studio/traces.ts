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

// ---------- Pure helpers of the S2 / S3 screens (UI-S2S3S9; canvas artboards "S2 Trace picker" and "S3 Trace view") ----------

/** The step kinds of the S3 waterfall legend. `err` is not a kind: a failed call is drawn red whatever its kind. */
export type SpanKind = 'read' | 'search' | 'write' | 'test' | 'tool' | 'other'

const READ_TOOLS = new Set(['read', 'glob', 'ls', 'notebookread'])
const SEARCH_TOOLS = new Set(['grep', 'websearch', 'webfetch', 'toolsearch'])
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'applypatch', 'apply_patch'])

/** The kind of one span, from its tool, intent and family. Nothing is guessed from the preview text. */
export function spanKind(s: Pick<TraceSpan, 'tool' | 'intent' | 'family'>): SpanKind {
  const tool = (s.tool ?? '').toLowerCase()
  const intent = (s.intent ?? '').toLowerCase()
  const family = (s.family ?? '').toLowerCase()
  if (/test/.test(intent)) return 'test'
  if (tool.startsWith('mcp') || family === 'mcp' || tool === 'task' || tool === 'agent') return 'tool'
  if (READ_TOOLS.has(tool) || /read/.test(intent)) return 'read'
  if (SEARCH_TOOLS.has(tool) || /search/.test(intent)) return 'search'
  if (WRITE_TOOLS.has(tool) || /edit|write/.test(intent)) return 'write'
  return 'other'
}

/** A duration in ms -> "850 ms" / "2.4 s" / "41 s" / "7 min" / "1h 5m". */
export function fmtMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)} s`
  if (s < 60) return `${Math.round(s)} s`
  const m = s / 60
  if (m < 60) return `${m < 10 && s % 60 ? m.toFixed(1) : Math.round(m)} min`
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`
}

const toMs = (ts: string | null): number | null => {
  if (!ts) return null
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : null
}

export interface WaterfallStep {
  type: 'step'
  /** Index in the whole trace, in display order; the key and the selection id. */
  id: string
  run: number
  span: TraceSpan
  kind: SpanKind
  failed: boolean
  /** Percent of the trace extent, or null when the span has no timestamp. */
  left: number | null
  width: number | null
}
export interface WaterfallRun {
  type: 'run'
  id: string
  run: TraceRun
  left: number | null
  width: number | null
}
export type WaterfallRow = WaterfallRun | WaterfallStep

export interface Waterfall {
  /** Extent of the trace in ms (0 when no timestamp exists). */
  totalMs: number
  rows: WaterfallRow[]
  steps: number
}

/** Lays the runs and their spans on one time axis. `runs` must already be in display order. */
export function buildWaterfall(runs: readonly TraceRun[]): Waterfall {
  const starts: number[] = []
  const ends: number[] = []
  for (const r of runs) {
    const a = toMs(r.started_at)
    if (a !== null) {
      starts.push(a)
      ends.push(toMs(r.ended_at) ?? (r.duration_s !== null ? a + r.duration_s * 1000 : a))
    }
    for (const s of r.spans) {
      const t = toMs(s.ts)
      if (t === null) continue
      starts.push(t)
      ends.push(toMs(s.ts_end) ?? t + (s.dur_ms ?? 0))
    }
  }
  const t0 = starts.length ? Math.min(...starts) : 0
  const totalMs = starts.length ? Math.max(...ends) - t0 : 0
  const pct = (ms: number) => (totalMs > 0 ? Math.min(100, Math.max(0, ((ms - t0) / totalMs) * 100)) : 0)
  const rows: WaterfallRow[] = []
  let n = 0
  runs.forEach((run, ri) => {
    const a = toMs(run.started_at)
    const dur = run.duration_s !== null ? run.duration_s * 1000 : null
    rows.push({ type: 'run', id: `run:${ri}`, run, left: a !== null && totalMs > 0 ? pct(a) : null, width: a !== null && dur !== null && totalMs > 0 ? Math.max(0.5, (dur / totalMs) * 100) : null })
    for (const span of run.spans) {
      const t = toMs(span.ts)
      rows.push({
        type: 'step',
        id: `step:${n++}`,
        run: ri,
        span,
        kind: spanKind(span),
        failed: span.ok === false,
        left: t !== null && totalMs > 0 ? pct(t) : null,
        width: t !== null && totalMs > 0 ? Math.max(0.4, ((span.dur_ms ?? 0) / totalMs) * 100) : null,
      })
    }
  })
  return { totalMs, rows, steps: n }
}

export interface ProfileLine {
  key: string
  label: string
  calls: number
  ms: number
  /** Percent of the wall time, at least 1 when the line has time. */
  pct: number
}

/**
 * Where the wall time went. Tool time comes from the span durations, by kind. "Between calls" is the wall time that no
 * call explains: the model thinking or a person answering. The trace does not tell which, so the line says both.
 */
export function buildProfile(runs: readonly TraceRun[], wallS: number | null): { lines: ProfileLine[]; slowest: TraceSpan[]; wallMs: number } {
  const wallMs = wallS !== null && wallS > 0 ? wallS * 1000 : 0
  const labels: Record<SpanKind, string> = { read: 'Read', search: 'Search', write: 'Edit', test: 'Tests', tool: 'Tool calls (MCP, agents)', other: 'Other calls (shell)' }
  const by = new Map<SpanKind, { calls: number; ms: number }>()
  const all: TraceSpan[] = []
  for (const r of runs) for (const s of r.spans) {
    all.push(s)
    const k = spanKind(s)
    const cur = by.get(k) ?? { calls: 0, ms: 0 }
    cur.calls += 1
    cur.ms += s.dur_ms ?? 0
    by.set(k, cur)
  }
  const toolMs = [...by.values()].reduce((a, v) => a + v.ms, 0)
  const lines: ProfileLine[] = [...by].map(([k, v]) => ({ key: k, label: labels[k], calls: v.calls, ms: v.ms, pct: 0 }))
  const between = wallMs > toolMs ? wallMs - toolMs : 0
  if (between > 0) lines.push({ key: 'between', label: 'Between calls', calls: 0, ms: between, pct: 0 })
  const base = Math.max(wallMs, toolMs)
  for (const l of lines) l.pct = base > 0 && l.ms > 0 ? Math.max(1, Math.round((l.ms / base) * 100)) : 0
  lines.sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label))
  const slowest = [...all].filter((s) => (s.dur_ms ?? 0) > 0).sort((a, b) => (b.dur_ms ?? 0) - (a.dur_ms ?? 0)).slice(0, 3)
  return { lines, slowest, wallMs }
}

/** The signals that are true on a row, in the order the index gives them. */
export function trueSignals(signals: Record<string, boolean | null> | null): string[] {
  return Object.entries(signals ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k)
}

/** "2026-11-01T10:00:00.000Z" -> "2026-11-01"; anything else as given; null -> null. */
export function dayOf(ts: string | null): string | null {
  if (!ts) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts)
  return m ? m[1]! : ts
}

export type Replay = 'yes' | 'partly' | 'no' | 'unpinned'

/** The "replayable" cell: a replay needs a complete pin. `replayable: false` always wins. */
export function replayOf(r: Pick<TraceRow, 'replayable' | 'pin'>): Replay {
  if (r.replayable === false) return 'no'
  if (!r.pin) return 'unpinned'
  return r.pin.complete === true ? 'yes' : 'partly'
}

export type HarnessKey = 'cc' | 'cx' | 'oc' | 'al' | 'other'

/** The avatar of a row's agent: its letters and ground. ALIEN01 is a host, so it wins over the harness. */
export function agentChip(r: Pick<TraceRow, 'executor' | 'harness' | 'host'>): { key: HarnessKey; letters: string; name: string } {
  const text = `${r.host ?? ''} ${r.executor ?? ''} ${r.harness ?? ''}`.toLowerCase()
  const raw = r.executor ?? r.harness ?? r.host ?? 'agent'
  if (/alien/.test(text)) return { key: 'al', letters: 'A1', name: 'ALIEN01' }
  if (/claude/.test(text)) return { key: 'cc', letters: 'CC', name: 'Claude Code' }
  if (/codex/.test(text)) return { key: 'cx', letters: 'CX', name: 'Codex' }
  if (/opencode/.test(text)) return { key: 'oc', letters: 'OC', name: 'opencode' }
  return { key: 'other', letters: (raw.replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?').toUpperCase(), name: raw }
}
