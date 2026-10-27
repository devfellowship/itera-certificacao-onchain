/**
 * One renderer per artifact kind (plan TMA L14c). The card header is `{path} · {size}` in mono, with
 * a segmented control that picks the view. The HTML preview is an <iframe sandbox=""> (empty sandbox:
 * no script, no same-origin, no form, no popup) with a CSP meta injected at the start of <head>.
 * Nothing here opens a blob: or data: URL in a new tab; the "open" action is the same sandboxed
 * iframe at full height, in a modal.
 *
 * Plan TMA L17: a STORED artifact (source `stored`) has no text until its card loads the bytes through
 * `requestBytes(href)`. Text kinds decode the Blob as UTF-8. A raster image shows the Blob through an
 * object URL on an <img> only (revoked on unmount). `agent/trace.jsonl` gets the trace list view.
 * Every stored card has a Download link: a client-side save of the loaded Blob (`<a download>`).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, requestBytes } from '../../lib/api/client'
import { JsonTree } from '../../tma/detail'
import { Modal, Segmented } from '../../tma/ui'
import { basenameOf, formatBytes, isRasterContentType, parsePatch, type Artifact } from './artifacts'
import { renderMarkdown } from './markdown'

export const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`

/** Puts the CSP meta at the start of <head>. Creates a head when the document has none. */
export function injectCsp(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + CSP_META + html.slice(at)
  }
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + `<head>${CSP_META}</head>` + html.slice(at)
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) {
    const at = doctype.index + doctype[0].length
    return html.slice(0, at) + `<head>${CSP_META}</head>` + html.slice(at)
  }
  return `<head>${CSP_META}</head>` + html
}

/* ---------- Views per kind ---------- */

export type ViewId = 'preview' | 'source' | 'diff' | 'tree' | 'raw' | 'rendered' | 'image' | 'text' | 'list'

/** True for a stored raster image: the bytes show through an object URL, there is no Source view. */
export function isStoredRaster(a: Artifact): boolean {
  return a.source === 'stored' && a.kind === 'image' && (isRasterContentType(a.contentType) || a.encoding === 'base64')
}

export function viewsOf(a: Artifact): Array<{ id: ViewId; label: string }> {
  const diff = a.diff ? [{ id: 'diff' as const, label: 'Diff' }] : []
  switch (a.kind) {
    case 'json':
      return [{ id: 'tree', label: 'Tree' }, { id: 'raw', label: 'Raw' }, ...diff]
    case 'ndjson':
      return [{ id: 'list', label: 'List' }, { id: 'raw', label: 'Raw' }, ...diff]
    case 'markdown':
      return [{ id: 'rendered', label: 'Rendered' }, { id: 'source', label: 'Source' }, ...diff]
    case 'html':
      return [{ id: 'preview', label: 'Preview' }, { id: 'source', label: 'Source' }, ...diff]
    case 'image':
      if (isStoredRaster(a)) return [{ id: 'image', label: 'Image' }, ...diff]
      if (a.source === 'stored') return [{ id: 'image', label: 'Image' }, { id: 'source', label: 'Source' }, ...diff]
      return a.text != null ? [{ id: 'image', label: 'Image' }, { id: 'source', label: 'Source' }, ...diff] : diff
    case 'binary':
      return diff
    case 'diff':
      return [{ id: 'diff', label: 'Diff' }]
    case 'text':
      return [{ id: 'text', label: 'Text' }, ...diff]
  }
}

/* ---------- HTML ---------- */

/** The browser-like frame of the design: three dots, `sandbox · {path}`, `no scripts`, and the sandboxed iframe. */
export function HtmlPreviewFrame({ html, path, tall, testId }: { html: string; path: string; tall?: boolean; testId?: string }) {
  const doc = useMemo(() => injectCsp(html), [html])
  return (
    <div className={['ra-frame', tall && 'ra-frame--tall'].filter(Boolean).join(' ')} data-testid={testId ?? 'html-preview'}>
      <div className="ra-frame__bar">
        <span className="ra-frame__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="ra-frame__addr dt-mono">sandbox · {path}</span>
        <span className="ra-frame__note dt-mono">no scripts</span>
      </div>
      {/* The sandbox attribute is EMPTY on purpose: every restriction applies. Do not add a token. */}
      <iframe className="ra-frame__view" sandbox="" srcDoc={doc} title={`Preview of ${path} (sandboxed, no scripts)`} data-testid="html-preview-iframe" />
    </div>
  )
}

/* ---------- JSON ---------- */

export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function JsonView({ text, view, testId }: { text: string; view: 'tree' | 'raw'; testId?: string }) {
  const parsed = useMemo(() => parseJsonText(text), [text])
  if (!parsed.ok) {
    return (
      <div className="ra-json" data-testid={testId ?? 'json-view'} data-view="raw">
        <p className="ra-warn" role="status" data-testid="json-invalid">
          Not valid JSON: {parsed.error}
        </p>
        <TextView text={text} />
      </div>
    )
  }
  if (view === 'tree') {
    return (
      <div className="ra-json" data-testid={testId ?? 'json-view'} data-view="tree">
        <JsonTree value={parsed.value} collapsedDepth={2} />
      </div>
    )
  }
  return (
    <div className="ra-json" data-testid={testId ?? 'json-view'} data-view="raw">
      <pre className="dt-pre ra-pre" data-testid="json-raw">
        {JSON.stringify(parsed.value, null, 2)}
      </pre>
    </div>
  )
}

/* ---------- Markdown ---------- */

export function MarkdownView({ text, testId }: { text: string; testId?: string }) {
  const nodes = useMemo(() => renderMarkdown(text), [text])
  return (
    <div className="ra-md" data-testid={testId ?? 'markdown-view'}>
      {nodes}
    </div>
  )
}

/* ---------- Image ---------- */

/**
 * The object URL of a Blob, for an <img src> ONLY. Created when the Blob changes, revoked on unmount
 * and when the Blob changes. Null when the platform has no `URL.createObjectURL` (a unit test without a mock).
 */
export function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== 'function') {
      setUrl(null)
      return
    }
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => {
      setUrl(null)
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(u)
    }
  }, [blob])
  return url
}

/**
 * SVG text goes through an <img> with a data: URL: an <img> never runs a script of the SVG.
 * A raster Blob (L17, a stored png/jpeg/gif/webp) goes through an object URL on the same <img>.
 */
export function ImageView({ text, blob, path, note, testId }: { text?: string; blob?: Blob; path: string; note?: string; testId?: string }) {
  const objectUrl = useObjectUrl(blob)
  if (blob) {
    return (
      <div className="ra-image" data-testid={testId ?? 'image-view'} data-src-kind="blob">
        {objectUrl ? <img src={objectUrl} alt={path} /> : <span className="ra-note dt-mono">{path}</span>}
      </div>
    )
  }
  if (text == null) {
    return (
      <p className="ra-note dt-mono" data-testid={testId ?? 'image-view'}>
        {note ?? 'binary file, content not stored'}
      </p>
    )
  }
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
  return (
    <div className="ra-image" data-testid={testId ?? 'image-view'} data-src-kind="data">
      <img src={src} alt={path} />
    </div>
  )
}

/* ---------- Trace (NDJSON, L17) ---------- */

/** The length of a one-line summary of a trace event. */
export const TRACE_SUMMARY_CHARS = 160

export interface TraceRow {
  /** 1-based line number. */
  n: number
  /** The raw line. */
  raw: string
  /** The parsed event, when the line is JSON. */
  value?: unknown
  /** `ok` = parsed; `broken` = not JSON (shown raw); `truncated` = the `{"truncated":true,…}` marker (a warning). */
  state: 'ok' | 'broken' | 'truncated'
  /** The one-line summary: `type` plus the first of `part.tool`, `part.text`, `message`, cut at 160 chars. */
  summary: string
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v
  return null
}

function cut(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

/** The summary of one parsed trace event. Exported for the unit test. */
export function traceSummary(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return cut(JSON.stringify(value) ?? '', TRACE_SUMMARY_CHARS)
  const ev = value as Record<string, unknown>
  const part = typeof ev.part === 'object' && ev.part !== null ? (ev.part as Record<string, unknown>) : null
  const type = firstString(ev.type) ?? '(no type)'
  const detail = firstString(part?.tool, part?.text, ev.message)
  return cut(detail ? `${type} · ${detail}` : type, TRACE_SUMMARY_CHARS)
}

/** Parses NDJSON into rows: one per non-empty line. Pure; exported for the unit test. */
export function parseTrace(text: string): TraceRow[] {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/)
  const out: TraceRow[] = []
  lines.forEach((raw, i) => {
    if (raw.trim() === '') return
    const parsed = parseJsonText(raw)
    if (!parsed.ok) {
      out.push({ n: i + 1, raw, state: 'broken', summary: cut(raw, TRACE_SUMMARY_CHARS) })
      return
    }
    const v = parsed.value
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && (v as Record<string, unknown>).truncated === true) {
      const r = v as Record<string, unknown>
      const why = firstString(r.reason, r.message)
      out.push({ n: i + 1, raw, value: v, state: 'truncated', summary: cut(`truncated: the stored trace ends here${why ? ` (${why})` : ''}`, TRACE_SUMMARY_CHARS) })
      return
    }
    out.push({ n: i + 1, raw, value: v, state: 'ok', summary: traceSummary(v) })
  })
  return out
}

function TraceRowView({ row }: { row: TraceRow }) {
  const [open, setOpen] = useState(false)
  if (row.state === 'broken') {
    return (
      <div className="ra-trace__row ra-trace__row--broken dt-mono" data-testid="trace-row" data-state="broken" data-n={row.n}>
        <span className="ra-code__n" aria-hidden="true">
          {row.n}
        </span>
        <span className="ra-trace__raw">{row.raw}</span>
      </div>
    )
  }
  if (row.state === 'truncated') {
    return (
      <div className="ra-trace__row ra-trace__row--warn dt-mono" role="status" data-testid="trace-row" data-state="truncated" data-n={row.n}>
        <span className="ra-code__n" aria-hidden="true">
          {row.n}
        </span>
        <span className="ra-warn ra-trace__warn">⚠ {row.summary}</span>
      </div>
    )
  }
  return (
    <div className="ra-trace__row dt-mono" data-testid="trace-row" data-state="ok" data-n={row.n} data-open={String(open)}>
      <button type="button" className="ra-trace__btn" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="trace-toggle">
        <span className="ra-code__n" aria-hidden="true">
          {row.n}
        </span>
        <span aria-hidden="true" className="ra-trace__caret">
          {open ? '▾' : '▸'}
        </span>
        <span className="ra-trace__summary">{row.summary}</span>
      </button>
      {open && (
        <div className="ra-trace__detail" data-testid="trace-detail">
          <JsonTree value={row.value} collapsedDepth={2} />
        </div>
      )}
    </div>
  )
}

/** `agent/trace.jsonl`: one row per line (List), or the text with line numbers (Raw). */
export function TraceView({ text, view, testId }: { text: string; view: 'list' | 'raw'; testId?: string }) {
  const rows = useMemo(() => parseTrace(text), [text])
  if (view === 'raw') return <TextView text={text} testId={testId ?? 'trace-view'} />
  if (rows.length === 0) {
    return (
      <p className="ra-note dt-mono" data-testid={testId ?? 'trace-view'} data-view="list">
        The trace is empty.
      </p>
    )
  }
  return (
    <div className="ra-trace" data-testid={testId ?? 'trace-view'} data-view="list" data-rows={rows.length}>
      {rows.map((r) => (
        <TraceRowView key={r.n} row={r} />
      ))}
    </div>
  )
}

/* ---------- Text ---------- */

const TEXT_COLLAPSE_BYTES = 200 * 1024

export function TextView({ text, testId }: { text: string; testId?: string }) {
  const big = text.length > TEXT_COLLAPSE_BYTES
  const [shown, setShown] = useState(!big)
  const lines = useMemo(() => (shown ? text.replace(/\n$/, '').split('\n') : []), [text, shown])
  if (!shown) {
    return (
      <div className="ra-collapsed" data-testid={testId ?? 'text-view'}>
        <span className="dt-mono dt-dim">{formatBytes(text.length)} of text</span>
        <button type="button" className="ra-text-btn" onClick={() => setShown(true)} data-testid="text-show">
          Show
        </button>
      </div>
    )
  }
  return (
    <pre className="ra-code" data-testid={testId ?? 'text-view'}>
      {lines.map((l, i) => (
        <span className="ra-code__line" key={i}>
          <span className="ra-code__n" aria-hidden="true">
            {i + 1}
          </span>
          <span className="ra-code__t">{l}</span>
        </span>
      ))}
    </pre>
  )
}

/* ---------- Diff ---------- */

const DIFF_COLLAPSE_LINES = 400

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
  old: number | null
  new: number | null
  text: string
}

export function diffLinesOf(lines: string[]): DiffLine[] {
  const out: DiffLine[] = []
  let o = 0
  let n = 0
  let inHunk = false
  for (const l of lines) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      inHunk = true
      out.push({ kind: 'hunk', old: null, new: null, text: l })
      continue
    }
    if (!inHunk) {
      out.push({ kind: 'meta', old: null, new: null, text: l })
      continue
    }
    if (l.startsWith('+')) out.push({ kind: 'add', old: null, new: n++, text: l.slice(1) })
    else if (l.startsWith('-')) out.push({ kind: 'del', old: o++, new: null, text: l.slice(1) })
    else if (l.startsWith('\\')) out.push({ kind: 'meta', old: null, new: null, text: l })
    else out.push({ kind: 'ctx', old: o++, new: n++, text: l.startsWith(' ') ? l.slice(1) : l })
  }
  return out
}

function DiffFile({ path, status, lines, binary }: { path: string; status: string; lines: string[]; binary: boolean }) {
  const big = lines.length > DIFF_COLLAPSE_LINES
  const [all, setAll] = useState(!big)
  const rows = useMemo(() => diffLinesOf(lines), [lines])
  const shown = all ? rows : rows.slice(0, 40)
  return (
    <section className="ra-diff__file" data-testid="diff-file" data-path={path}>
      <header className="ra-diff__head dt-mono">
        <span className="ra-diff__path">{path}</span>
        <span className="dt-dim">{status}{binary ? ' · binary' : ''} · {lines.length} line{lines.length === 1 ? '' : 's'}</span>
      </header>
      <pre className="ra-code ra-diff__body">
        {shown.map((r, i) => (
          <span className={`ra-code__line ra-diff__l ra-diff__l--${r.kind}`} key={i}>
            <span className="ra-code__n" aria-hidden="true">
              {r.old ?? ''}
            </span>
            <span className="ra-code__n" aria-hidden="true">
              {r.new ?? ''}
            </span>
            <span className="ra-diff__sign" aria-hidden="true">
              {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}
            </span>
            <span className="ra-code__t">{r.text}</span>
          </span>
        ))}
      </pre>
      {!all && (
        <div className="ra-collapsed">
          <span className="dt-mono dt-dim">{lines.length - shown.length} more lines</span>
          <button type="button" className="ra-text-btn" onClick={() => setAll(true)} data-testid="diff-show-all">
            Show all
          </button>
        </div>
      )}
    </section>
  )
}

/** A unified diff: one block per file, `+` in success colour, `-` in danger, hunk headers dim, line numbers. */
export function DiffView({ diff, testId }: { diff: string; testId?: string }) {
  const files = useMemo(() => parsePatch(diff), [diff])
  if (files.length === 0) {
    return (
      <p className="ra-note dt-mono" data-testid={testId ?? 'diff-view'}>
        The diff is empty.
      </p>
    )
  }
  return (
    <div className="ra-diff" data-testid={testId ?? 'diff-view'}>
      {files.map((f, i) => (
        <DiffFile key={`${f.path}-${i}`} path={f.path} status={f.status} lines={f.lines} binary={f.binary} />
      ))}
    </div>
  )
}

/* ---------- The card ---------- */

/** The loaded bytes of a stored artifact: the text of a text kind, or the Blob of a raster image. */
export interface LoadedContent {
  text?: string
  blob?: Blob
}

export type StoredState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; content: LoadedContent } | { kind: 'error'; status: number; message: string }

/** Reads a Blob as UTF-8 text. `Blob.text()` when the platform has it, else a FileReader (jsdom). */
export async function blobText(blob: Blob): Promise<string> {
  if (typeof (blob as { text?: unknown }).text === 'function') return blob.text()
  if (typeof (blob as { arrayBuffer?: unknown }).arrayBuffer === 'function') return new TextDecoder('utf-8').decode(await blob.arrayBuffer())
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.onload = () => resolve(String(r.result ?? ''))
    r.readAsText(blob, 'utf-8')
  })
}

/** The loader of a stored artifact's bytes. The default is the API client; a test passes its own. */
export type ArtifactLoader = (a: Artifact) => Promise<Blob>
export const apiLoader: ArtifactLoader = (a) => {
  if (!a.href) return Promise.reject(new ApiError(0, 'The artifact has no href.'))
  return requestBytes(a.href)
}

/** True when a stored artifact must fetch its bytes: no text at hand (a stored `patch.diff` already holds its diff). */
export function needsLoad(a: Artifact): boolean {
  return a.source === 'stored' && a.text == null && !(a.kind === 'diff' && a.diff != null)
}

/**
 * Loads the bytes of a stored artifact once, when `active` first turns true. A text kind decodes the
 * Blob as UTF-8; a raster image keeps the Blob. An artifact that needs no load is `idle` and never loads.
 */
export function useStoredContent(a: Artifact, active: boolean, loader: ArtifactLoader): StoredState {
  const stored = needsLoad(a)
  const key = a.id + '|' + (a.href ?? '')
  const [state, setState] = useState<{ key: string; s: StoredState }>({ key, s: { kind: 'idle' } })
  const startedFor = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!stored || !active || startedFor.current === key) return
    startedFor.current = key
    setState({ key, s: { kind: 'loading' } })
    loader(a)
      .then(async (blob) => {
        const content: LoadedContent = isStoredRaster(a) ? { blob } : { text: await blobText(blob), blob }
        if (mounted.current) setState({ key, s: { kind: 'ok', content } })
      })
      .catch((e: unknown) => {
        if (!mounted.current) return
        const status = e instanceof ApiError ? e.status : 0
        const message = e instanceof Error ? e.message : String(e)
        setState({ key, s: { kind: 'error', status, message } })
      })
    // `a` and `loader` are read when the load starts; the start is keyed by `key`, once per artifact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, active, key])
  if (!stored) return { kind: 'idle' }
  return state.key === key ? state.s : { kind: 'idle' }
}

/** A client-side save of a loaded Blob: a detached `<a download>` with an object URL, clicked, then revoked. The page never navigates. */
export function saveBlob(blob: Blob, filename: string): void {
  if (typeof URL.createObjectURL !== 'function') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  try {
    a.click()
  } finally {
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

export function renderBody(a: Artifact, view: ViewId, loaded?: LoadedContent): ReactNode {
  if (view === 'diff' && a.diff) return <DiffView diff={a.diff} />
  const text = a.text ?? loaded?.text
  switch (a.kind) {
    case 'json':
      return <JsonView text={text ?? ''} view={view === 'raw' ? 'raw' : 'tree'} />
    case 'ndjson':
      return <TraceView text={text ?? ''} view={view === 'raw' ? 'raw' : 'list'} />
    case 'markdown':
      return view === 'source' ? <TextView text={text ?? ''} /> : <MarkdownView text={text ?? ''} />
    case 'html':
      return view === 'source' ? <TextView text={text ?? ''} /> : <HtmlPreviewFrame html={text ?? ''} path={a.path} />
    case 'image':
      if (loaded?.blob && isStoredRaster(a)) return <ImageView blob={loaded.blob} path={a.path} />
      return view === 'source' ? <TextView text={text ?? ''} /> : <ImageView text={text} path={a.path} note={a.note} />
    case 'binary':
      return (
        <p className="ra-note dt-mono" data-testid="binary-note">
          {a.note ?? 'binary file, content not stored'}
        </p>
      )
    case 'diff':
      return a.diff ? <DiffView diff={a.diff} /> : null
    case 'text':
      return <TextView text={text ?? ''} />
  }
}

/**
 * One artifact in a card: header `{path} · {size}` (mono), the segmented view picker, an "Open" action
 * for HTML (the same sandboxed iframe at full height), and a collapse toggle when `collapsible`.
 * A stored artifact (L17) loads its bytes when the body first shows; the card shows `Loading…`, then the
 * content, or an error line with the status. Its header has a Download link for the loaded Blob.
 */
export function ArtifactCard({ artifact: a, collapsible, defaultOpen = true, className, testId, loader = apiLoader }: { artifact: Artifact; collapsible?: boolean; defaultOpen?: boolean; className?: string; testId?: string; loader?: ArtifactLoader }) {
  const [open, setOpen] = useState(defaultOpen)
  const [expanded, setExpanded] = useState(false)
  const stored = useStoredContent(a, open, loader)
  const loaded = stored.kind === 'ok' ? stored.content : undefined
  const html = a.text ?? loaded?.text
  const views = viewsOf(a)
  const [view, setView] = useState<ViewId>(views[0]?.id ?? 'text')
  const current = views.some((v) => v.id === view) ? view : (views[0]?.id ?? 'text')
  const isStored = a.source === 'stored'
  const lazy = needsLoad(a)
  const notStored = a.kind === 'binary' || (a.kind === 'image' && a.text == null && !isStored)
  /** The bytes to save: the loaded Blob, else the text at hand (a stored `patch.diff` carries its diff). */
  const saveSource = loaded?.blob ?? (a.text != null ? new Blob([a.text], { type: a.contentType ?? 'text/plain' }) : a.diff != null && a.kind === 'diff' ? new Blob([a.diff], { type: a.contentType ?? 'text/x-diff' }) : null)
  const canSave = isStored && saveSource != null
  const downloadName = basenameOf(a.storedPath ?? a.path)
  return (
    <section
      className={['tma-card', 'dt-card', 'ra-card', className].filter(Boolean).join(' ')}
      data-testid={testId ?? 'artifact-card'}
      data-kind={a.kind}
      data-path={a.path}
      data-source={a.source}
      data-open={String(open)}
      data-load={isStored ? (lazy ? stored.kind : 'ok') : undefined}
    >
      <div className="dt-card__head ra-card__head">
        <div className="dt-card__title ra-card__title">
          {collapsible && (
            <button type="button" className="ra-card__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="artifact-toggle">
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            </button>
          )}
          <span className="dt-mono ra-card__path" data-testid="artifact-title">
            {a.path} · {notStored ? 'not stored' : formatBytes(a.bytes)}
          </span>
          {isStored && (
            <span className="ra-card__tag dt-mono" title={a.storedPath} data-testid="artifact-stored-tag">
              stored
            </span>
          )}
        </div>
        <div className="ra-card__actions">
          {views.length > 1 && <Segmented items={views} value={current} onChange={(v) => setView(v)} />}
          {a.kind === 'html' && html != null && (
            <button type="button" className="ra-text-btn" onClick={() => setExpanded(true)} data-testid="artifact-open">
              Open
            </button>
          )}
          {isStored && (
            <button type="button" className="ra-text-btn" disabled={!canSave} onClick={() => saveSource && saveBlob(saveSource, downloadName)} data-testid="artifact-download" data-filename={downloadName} title={canSave ? `Save ${downloadName}` : 'Available after the file loads'}>
              Download
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="dt-card__body ra-card__body">
          {lazy && stored.kind === 'loading' && (
            <span className="tma-muted" data-testid="artifact-loading" aria-busy="true">
              Loading…
            </span>
          )}
          {lazy && stored.kind === 'error' && (
            <p className="ra-error dt-mono" role="alert" data-testid="artifact-error">
              Could not load {a.path}: {stored.status ? `HTTP ${stored.status} · ` : ''}
              {stored.message}
            </p>
          )}
          {(!lazy || stored.kind === 'ok') && renderBody(a, current, loaded)}
        </div>
      )}
      {a.kind === 'html' && html != null && (
        <Modal open={expanded} onClose={() => setExpanded(false)} title={a.path} width={1280} testId="artifact-expanded">
          <HtmlPreviewFrame html={html} path={a.path} tall testId="html-preview-tall" />
        </Modal>
      )}
    </section>
  )
}
