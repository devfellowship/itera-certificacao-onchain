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
  /** MT-12/13: source-agnostic task fields (the DFL source writes its task title, DFL id and task-details URL). */
  task_name?: string | null
  external_id?: string | null
  external_url?: string | null
  /** MT-11: the selection marks a merged PR of at most 3 files. Absent on rows from an older selection. */
  small_diff?: boolean | null
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
  /** MT-11: 'true' or 'false'; any other value is dropped. */
  small_diff?: string | null
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
  if (q.small_diff === 'true' || q.small_diff === 'false') p.set('small_diff', q.small_diff)
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

/** MT-11: the file count of the PR (pr.files_changed), when the selection sent one. */
export function prFiles(pr: unknown): number | null {
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return null
  const n = (pr as { files_changed?: unknown }).files_changed
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null
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

// ---------- Step categories (plan 20261118-melhorias-tma, task MT-08; Tainan TG 32382) ----------
//
// The category of a step is the `intent` that session-trajectory wrote on the span in the layer-1 file. That parser
// (dfl-harness:skills/session-trajectory/st_parse.py, INTENT_LIST_VERSION 2) is the same one whose spans feed the
// decisiongraph.devfellowship.com analytics ("Bash - <intent>"), so this view and the analytics count the same
// categories. The parser is deterministic (shape -> rule, compound commands -> the PRIO order). Nothing here classifies
// again and nothing calls a model: this module only reads the field and gives it plain words and a color.

/** The fixed intent list of st_parse.py, INTENT_LIST_VERSION 2. A new list version must be copied here. */
export const INTENTS = [
  'pr-read', 'pr-write/merge', 'ci-read', 'ci-watch/poll', 'git-read', 'git-write',
  'build/test', 'deploy', 'credential-fetch', 'plan-mcp', 'skill-run', 'mcp-read',
  'mcp-write', 'file-read', 'file-edit', 'search', 'web-research', 'ops-inspect',
  'ops-change', 'spawn-subagent', 'message-agent', 'reply-human', 'wait/sleep',
  'browser-check', 'github-api', 'media-generate', 'other',
] as const
export type Intent = (typeof INTENTS)[number]
/** A span with no intent (the parser left it to a model that has not run) is "unlabeled", as in the analytics. */
export type StepCategory = Intent | 'unlabeled'

const INTENT_SET: ReadonlySet<string> = new Set(INTENTS)

/** The plain words of each category (the decisiongraph analytics names). */
export const CATEGORY_LABEL: Record<StepCategory, string> = {
  'pr-read': 'PR read',
  'pr-write/merge': 'PR write/merge',
  'ci-read': 'CI read',
  'ci-watch/poll': 'CI watch/poll',
  'git-read': 'git read',
  'git-write': 'git write',
  'build/test': 'build/test',
  deploy: 'deploy',
  'credential-fetch': 'credential fetch',
  'plan-mcp': 'plan MCP',
  'skill-run': 'skill run',
  'mcp-read': 'MCP read',
  'mcp-write': 'MCP write',
  'file-read': 'file read',
  'file-edit': 'file edit',
  search: 'search',
  'web-research': 'web research',
  'ops-inspect': 'ops inspect',
  'ops-change': 'ops change',
  'spawn-subagent': 'spawn subagent',
  'message-agent': 'message agent',
  'reply-human': 'reply to human',
  'wait/sleep': 'wait/sleep',
  'browser-check': 'browser check',
  'github-api': 'GitHub API',
  'media-generate': 'media generate',
  other: 'other',
  unlabeled: 'unlabeled',
}

/**
 * The category of one span. No intent -> "unlabeled"; an intent outside the list -> "other" (the rule of the
 * analytics build, session-trajectory/analytics/build.py). Never reads the preview.
 */
export function spanCategory(s: Pick<TraceSpan, 'intent'>): StepCategory {
  const intent = s.intent
  if (!intent || intent === 'needs-model') return 'unlabeled'
  return INTENT_SET.has(intent) ? (intent as Intent) : 'other'
}

/** The CSS-safe key of a category: "pr-write/merge" -> "pr-write-merge". */
export const categoryKey = (c: StepCategory): string => c.replace(/[^a-z0-9]+/g, '-')

/** The shell tools: Claude Code `Bash`, and the shell tools of Codex and opencode. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'bash'])
/** A shell span, by its tool name (the family is not used: a fixture or an adapter can set it loosely). */
export const isShellSpan = (s: Pick<TraceSpan, 'tool'>): boolean => SHELL_TOOLS.has(s.tool ?? '')

/** "devfellowship/dfl-mcp-server" -> "dfl-mcp-server". */
const shortRepo = (t: string): string => t.slice(t.lastIndexOf('/') + 1) || t

const LEAD_SKIP = /^(cd|export|set|source|\.|pushd|popd|unset|true|:|[A-Za-z_][A-Za-z0-9_]*=\S*)$/

/** The first command of a raw shell line that is not a `cd` / `export` / assignment prefix: "gh pr list". */
function firstCommand(preview: string): string | null {
  for (const part of preview.split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const words = part.trim().split(/\s+/).filter(Boolean)
    if (!words.length || LEAD_SKIP.test(words[0]!)) continue
    const head = words.slice(0, words[0] === 'git' || words[0] === 'gh' || words[0] === 'npm' || words[0] === 'npx' ? 3 : 1)
    return head.filter((w) => !w.startsWith('-')).join(' ')
  }
  return null
}

/**
 * A short summary of a shell step: its commands without arguments, then the repo it ran in.
 * The base is the span `shape` (st_parse.bash_shape: the `cd` / `echo` decoration and the arguments are already gone,
 * at most 3 commands joined by " + "). With no shape, the first command of the preview after any `cd ...;` prefix.
 */
export function commandSummary(s: Pick<TraceSpan, 'shape' | 'preview' | 'target_kind' | 'target'>): string {
  let cmd = s.shape
    ? s.shape
        .replace(/<skill:([A-Za-z0-9_.-]+)>\/?/g, (_m, k: string) => `${k}/`)
        .replace(/\/\s/g, ' ')
        .replace(/\/$/, '')
        .replace(/\s*2>&1/g, '')
        .replace(/\s*<(inline|args)>/g, '')
        .replace(/<(file|repo)>/g, '$1')
        .split(' + ')
        .filter((c) => c.trim() && c.trim() !== 'null')
        .join(' + ')
        .trim()
    : s.preview
      ? firstCommand(s.preview)
      : null
  if (cmd === '') cmd = null
  const where = s.target_kind === 'repo' && s.target ? shortRepo(s.target) : null
  return [cmd, where].filter(Boolean).join(' · ') || '—'
}

/** The label and summary of one waterfall row. A shell step shows its category, not the repo it ran in. */
export function stepLabel(s: TraceSpan): { label: string; summary: string; category: StepCategory } {
  const category = spanCategory(s)
  if (isShellSpan(s)) return { label: CATEGORY_LABEL[category], summary: commandSummary(s), category }
  return { label: toolLabel(s.tool) ?? '—', summary: s.target ?? ([s.shape, s.intent].filter(Boolean).join(' / ') || '—'), category }
}

/** The categories of the given steps, most calls first (ties by label), for the waterfall legend. */
export function categoryLegend(steps: readonly Pick<TraceSpan, 'intent'>[]): Array<{ category: StepCategory; label: string; calls: number }> {
  const n = new Map<StepCategory, number>()
  for (const s of steps) {
    const c = spanCategory(s)
    n.set(c, (n.get(c) ?? 0) + 1)
  }
  return [...n]
    .map(([category, calls]) => ({ category, label: CATEGORY_LABEL[category], calls }))
    .sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label))
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
  /** The decisiongraph category of the step (its bar color and legend entry). */
  category: StepCategory
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
        category: spanCategory(span),
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

/** One label map for the signal keys of the index (S2 chips, S2 panel line, S3 panel line). */
export const SIGNAL_LABEL: Record<string, string> = {
  correction: 'correction',
  ci_rerun: 're-run',
  revert: 'revert',
  red_ci: 'red CI',
  abandoned: 'abandoned',
}
/** A signal key as plain words; an unknown key falls back to the key with "_" as a space. */
export const signalLabel = (k: string): string => SIGNAL_LABEL[k] ?? k.replace(/_/g, ' ')

/** A filter or index value as plain words: "trace_review" -> "trace review". */
export const plainValue = (v: string): string => v.replace(/_/g, ' ')

/** `mcp__<server>__<tool>` as "mcp: <server>-<tool>"; any other tool name as given. */
export function toolLabel(name: string | null | undefined): string | null {
  if (!name) return null
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `mcp: ${m[1]}-${m[2]}` : name
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "2026-11-03T10:00:00.000Z" -> "3 Nov" (the UTC day); anything else as given; null -> null. */
export function shortDay(ts: string | null): string | null {
  if (!ts) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ts)
  if (!m) return ts
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month}` : ts
}

/** "2026-11-03T10:03:00.000Z" -> "10:03" (UTC); anything else -> null. */
export function clockOf(ts: string | null): string | null {
  const m = ts ? /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(ts) : null
  return m ? m[1]! : null
}

/** Newest first by `started_at`; a row with no date goes last; the order of equal dates is kept. */
export function newestFirst<T extends { started_at: string | null }>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const x = a.r.started_at ?? ''
      const y = b.r.started_at ?? ''
      return x === y ? a.i - b.i : !x ? 1 : !y ? -1 : x < y ? 1 : -1
    })
    .map((e) => e.r)
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
