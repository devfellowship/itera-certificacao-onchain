/**
 * One renderer per artifact kind (plan TMA L14c). The card header is `{path} · {size}` in mono, with
 * a segmented control that picks the view. The HTML preview is an <iframe sandbox=""> (empty sandbox:
 * no script, no same-origin, no form, no popup) with a CSP meta injected at the start of <head>.
 * Nothing here opens a blob: or data: URL in a new tab; the "open" action is the same sandboxed
 * iframe at full height, in a modal.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { JsonTree } from '../../tma/detail'
import { Modal, Segmented } from '../../tma/ui'
import { formatBytes, parsePatch, type Artifact } from './artifacts'
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

export type ViewId = 'preview' | 'source' | 'diff' | 'tree' | 'raw' | 'rendered' | 'image' | 'text'

export function viewsOf(a: Artifact): Array<{ id: ViewId; label: string }> {
  const diff = a.diff ? [{ id: 'diff' as const, label: 'Diff' }] : []
  switch (a.kind) {
    case 'json':
      return [{ id: 'tree', label: 'Tree' }, { id: 'raw', label: 'Raw' }, ...diff]
    case 'markdown':
      return [{ id: 'rendered', label: 'Rendered' }, { id: 'source', label: 'Source' }, ...diff]
    case 'html':
      return [{ id: 'preview', label: 'Preview' }, { id: 'source', label: 'Source' }, ...diff]
    case 'image':
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

/** SVG text goes through an <img> with a data: URL: an <img> never runs a script of the SVG. */
export function ImageView({ text, path, note, testId }: { text?: string; path: string; note?: string; testId?: string }) {
  if (text == null) {
    return (
      <p className="ra-note dt-mono" data-testid={testId ?? 'image-view'}>
        {note ?? 'binary file, content not stored'}
      </p>
    )
  }
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
  return (
    <div className="ra-image" data-testid={testId ?? 'image-view'}>
      <img src={src} alt={path} />
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

export function renderBody(a: Artifact, view: ViewId): ReactNode {
  if (view === 'diff' && a.diff) return <DiffView diff={a.diff} />
  switch (a.kind) {
    case 'json':
      return <JsonView text={a.text ?? ''} view={view === 'raw' ? 'raw' : 'tree'} />
    case 'markdown':
      return view === 'source' ? <TextView text={a.text ?? ''} /> : <MarkdownView text={a.text ?? ''} />
    case 'html':
      return view === 'source' ? <TextView text={a.text ?? ''} /> : <HtmlPreviewFrame html={a.text ?? ''} path={a.path} />
    case 'image':
      return view === 'source' ? <TextView text={a.text ?? ''} /> : <ImageView text={a.text} path={a.path} note={a.note} />
    case 'binary':
      return (
        <p className="ra-note dt-mono" data-testid="binary-note">
          {a.note ?? 'binary file, content not stored'}
        </p>
      )
    case 'diff':
      return a.diff ? <DiffView diff={a.diff} /> : null
    case 'text':
      return <TextView text={a.text ?? ''} />
  }
}

/**
 * One artifact in a card: header `{path} · {size}` (mono), the segmented view picker, an "Open" action
 * for HTML (the same sandboxed iframe at full height), and a collapse toggle when `collapsible`.
 */
export function ArtifactCard({ artifact: a, collapsible, defaultOpen = true, className, testId }: { artifact: Artifact; collapsible?: boolean; defaultOpen?: boolean; className?: string; testId?: string }) {
  const views = viewsOf(a)
  const [view, setView] = useState<ViewId>(views[0]?.id ?? 'text')
  const [open, setOpen] = useState(defaultOpen)
  const [expanded, setExpanded] = useState(false)
  const current = views.some((v) => v.id === view) ? view : (views[0]?.id ?? 'text')
  return (
    <section className={['tma-card', 'dt-card', 'ra-card', className].filter(Boolean).join(' ')} data-testid={testId ?? 'artifact-card'} data-kind={a.kind} data-path={a.path} data-open={String(open)}>
      <div className="dt-card__head ra-card__head">
        <div className="dt-card__title ra-card__title">
          {collapsible && (
            <button type="button" className="ra-card__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="artifact-toggle">
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            </button>
          )}
          <span className="dt-mono ra-card__path" data-testid="artifact-title">
            {a.path} · {a.kind === 'binary' || (a.kind === 'image' && a.text == null) ? 'not stored' : formatBytes(a.bytes)}
          </span>
        </div>
        <div className="ra-card__actions">
          {views.length > 1 && <Segmented items={views} value={current} onChange={(v) => setView(v)} />}
          {a.kind === 'html' && a.text != null && (
            <button type="button" className="ra-text-btn" onClick={() => setExpanded(true)} data-testid="artifact-open">
              Open
            </button>
          )}
        </div>
      </div>
      {open && <div className="dt-card__body ra-card__body">{renderBody(a, current)}</div>}
      {a.kind === 'html' && a.text != null && (
        <Modal open={expanded} onClose={() => setExpanded(false)} title={a.path} width={1280} testId="artifact-expanded">
          <HtmlPreviewFrame html={a.text} path={a.path} tall testId="html-preview-tall" />
        </Modal>
      )}
    </section>
  )
}
