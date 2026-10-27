// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Artifact } from './artifacts'
import { safeHref } from './markdown'
import { ArtifactCard, CSP_META, DiffView, HtmlPreviewFrame, ImageView, JsonView, MarkdownView, TextView, TraceView, injectCsp, parseTrace, traceSummary, viewsOf } from './renderers'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
})
function mount(node: React.ReactNode) {
  const c = document.createElement('div')
  document.body.append(c)
  root = createRoot(c)
  act(() => root!.render(node))
  return c
}
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe('HTML preview', () => {
  it('is an iframe with an EMPTY sandbox attribute and a srcdoc that starts with the CSP meta in <head>', () => {
    const html = '<!doctype html><html><head><title>R</title></head><body><script>alert(1)</script><h1>Report</h1></body></html>'
    const c = mount(<HtmlPreviewFrame html={html} path="out/report.html" />)
    const frame = c.querySelector('iframe')!
    expect(frame).not.toBeNull()
    expect(frame.hasAttribute('sandbox')).toBe(true)
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    const doc = frame.getAttribute('srcdoc')!
    expect(doc.startsWith('<!doctype html><html><head>' + CSP_META)).toBe(true)
    expect(doc.indexOf(CSP_META)).toBeLessThan(doc.indexOf('<title>'))
    expect(c.textContent).toContain('sandbox · out/report.html')
    expect(c.textContent).toContain('no scripts')
    // No script of the document reaches our DOM.
    expect(document.querySelector('script')).toBeNull()
  })
  it('injectCsp creates a head when the document has none', () => {
    expect(injectCsp('<html><body>x</body></html>')).toBe(`<html><head>${CSP_META}</head><body>x</body></html>`)
    expect(injectCsp('<p>fragment</p>')).toBe(`<head>${CSP_META}</head><p>fragment</p>`)
    expect(injectCsp('<!DOCTYPE html>\n<body>x</body>')).toBe(`<!DOCTYPE html><head>${CSP_META}</head>\n<body>x</body>`)
    expect(injectCsp('<HEAD lang="x">a</HEAD>')).toBe(`<HEAD lang="x">${CSP_META}a</HEAD>`)
  })
  it('the card "Open" action shows the same sandboxed iframe at full height, never a blob: or data: URL', () => {
    const a: Artifact = { id: 'added:out/r.html', path: 'out/r.html', kind: 'html', bytes: 10, text: '<html><body>hi</body></html>', source: 'added' }
    const c = mount(<ArtifactCard artifact={a} />)
    expect(c.querySelector('iframe[data-testid="html-preview-iframe"]')).not.toBeNull()
    click(c.querySelector('[data-testid="artifact-open"]'))
    const tall = document.querySelector('[data-testid="html-preview-tall"] iframe')!
    expect(tall).not.toBeNull()
    expect(tall.getAttribute('sandbox')).toBe('')
    expect(tall.getAttribute('src')).toBeNull()
    expect(document.querySelectorAll('a[href^="blob:"], a[href^="data:text/html"]')).toHaveLength(0)
  })
})

describe('Markdown', () => {
  it('escapes HTML: the <script> text is visible and no script element exists', () => {
    const c = mount(<MarkdownView text={'# T\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>'} />)
    expect(c.querySelector('script')).toBeNull()
    expect(c.querySelector('img')).toBeNull()
    expect(c.textContent).toContain('<script>alert(1)</script>')
    expect(c.querySelector('h1')!.textContent).toBe('T')
  })
  it('drops a javascript: href and keeps http, mailto and relative hrefs with rel="noopener noreferrer"', () => {
    const c = mount(<MarkdownView text={'[bad](javascript:alert(1)) [bad2](JAVA\tSCRIPT:alert(1)) [data](data:text/html,x) [ok](https://example.com/a) [mail](mailto:a@b.c) [rel](./x.md)'} />)
    const links = Array.from(c.querySelectorAll('a'))
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['https://example.com/a', 'mailto:a@b.c', './x.md'])
    for (const l of links) expect(l.getAttribute('rel')).toBe('noopener noreferrer')
    expect(c.textContent).toContain('bad')
    expect(c.textContent).toContain('data')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('vbscript:x')).toBeNull()
    expect(safeHref('//evil.example')).toBeNull()
    expect(safeHref('#top')).toBe('#top')
  })
  it('renders lists, code, emphasis, tables and blockquotes', () => {
    const c = mount(<MarkdownView text={'- a\n- b\n\n1. one\n2. two\n\n`x` **b** *i*\n\n```js\nlet a = 1\n```\n\n| h1 | h2 |\n|----|----|\n| c1 | c2 |\n\n> q'} />)
    expect(c.querySelectorAll('ul li')).toHaveLength(2)
    expect(c.querySelectorAll('ol li')).toHaveLength(2)
    expect(c.querySelector('code')!.textContent).toBe('x')
    expect(c.querySelector('strong')!.textContent).toBe('b')
    expect(c.querySelector('em')!.textContent).toBe('i')
    expect(c.querySelector('pre code')!.textContent).toBe('let a = 1')
    expect(c.querySelectorAll('table th')).toHaveLength(2)
    expect(c.querySelector('table td')!.textContent).toBe('c1')
    expect(c.querySelector('blockquote')!.textContent).toContain('q')
  })
})

describe('JSON', () => {
  it('invalid JSON shows Raw with a warning line', () => {
    const c = mount(<JsonView text={'{"a": 1,'} view="tree" />)
    expect(c.querySelector('[data-testid="json-invalid"]')!.textContent).toContain('Not valid JSON')
    expect(c.querySelector('[data-testid="json-view"]')!.getAttribute('data-view')).toBe('raw')
    expect(c.querySelector('[data-testid="json-tree"]')).toBeNull()
    expect(c.textContent).toContain('{"a": 1,')
  })
  it('valid JSON shows the tree with object · N keys, and Raw pretty-prints', () => {
    const text = '{"filename":"report.html","ok":true,"totals":{"runs":1284}}'
    const c = mount(<JsonView text={text} view="tree" />)
    expect(c.querySelector('[data-testid="json-tree"]')).not.toBeNull()
    expect(c.textContent).toContain('object · 3 keys')
    expect(c.textContent).toContain('"report.html"')
    const r = mount(<JsonView text={text} view="raw" />)
    expect(r.querySelector('[data-testid="json-raw"]')!.textContent).toBe(JSON.stringify(JSON.parse(text), null, 2))
  })
})

describe('Image, text, diff', () => {
  it('SVG text renders as an <img> with a data:image/svg+xml src', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const c = mount(<ImageView text={svg} path="a.svg" />)
    const img = c.querySelector('img')!
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')!.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(c.querySelector('svg')).toBeNull()
    expect(c.querySelector('script')).toBeNull()
  })
  it('a raster image shows the "content not stored" note', () => {
    const c = mount(<ImageView path="a.png" note="binary file, content not stored" />)
    expect(c.textContent).toContain('binary file, content not stored')
    expect(c.querySelector('img')).toBeNull()
  })
  it('text has line numbers; over 200 KB it is collapsed with Show', () => {
    const c = mount(<TextView text={'a\nb\nc\n'} />)
    expect(c.querySelectorAll('.ra-code__line')).toHaveLength(3)
    expect(c.querySelector('.ra-code__n')!.textContent).toBe('1')
    const big = mount(<TextView text={'x'.repeat(201 * 1024)} />)
    expect(big.querySelector('.ra-code__line')).toBeNull()
    click(big.querySelector('[data-testid="text-show"]'))
    expect(big.querySelectorAll('.ra-code__line')).toHaveLength(1)
  })
  it('diff view colours + and - lines, numbers them, and collapses a file over 400 lines', () => {
    const small = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n'
    const c = mount(<DiffView diff={small} />)
    expect(c.querySelectorAll('[data-testid="diff-file"]')).toHaveLength(1)
    expect(c.querySelector('.ra-diff__l--add .ra-code__t')!.textContent).toBe('c')
    expect(c.querySelector('.ra-diff__l--del .ra-code__t')!.textContent).toBe('b')
    expect(c.querySelector('.ra-diff__l--hunk')).not.toBeNull()
    const ctx = c.querySelector('.ra-diff__l--ctx')!
    expect(Array.from(ctx.querySelectorAll('.ra-code__n')).map((n) => n.textContent)).toEqual(['1', '1'])
    const lines = Array.from({ length: 450 }, (_, i) => `+line ${i}`).join('\n')
    const big = mount(<DiffView diff={`diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,450 @@\n${lines}\n`} />)
    expect(big.querySelector('[data-testid="diff-show-all"]')).not.toBeNull()
    expect(big.querySelectorAll('.ra-code__line').length).toBeLessThan(100)
    click(big.querySelector('[data-testid="diff-show-all"]'))
    expect(big.querySelectorAll('.ra-diff__l--add')).toHaveLength(450)
  })
  it('the card header is "{path} · {size}" in mono, and a collapsible card hides its body', () => {
    const a: Artifact = { id: 'added:notes.md', path: 'notes.md', kind: 'markdown', bytes: 14537, text: '# hi', source: 'added' }
    const c = mount(<ArtifactCard artifact={a} collapsible defaultOpen={false} />)
    const title = c.querySelector('[data-testid="artifact-title"]')!
    expect(title.textContent).toBe('notes.md · 14.2 KB')
    expect(title.classList.contains('dt-mono')).toBe(true)
    expect(c.querySelector('.ra-card__body')).toBeNull()
    click(c.querySelector('[data-testid="artifact-toggle"]'))
    expect(c.querySelector('.ra-card__body h1')!.textContent).toBe('hi')
  })
})

/* ---------- L17: stored outputs ---------- */

/** A Blob with `.text()` and `.arrayBuffer()` (jsdom's own Blob has neither; a Response gives Node's). */
const blobOf = (data: string | Uint8Array, type: string) => new Response(data as BodyInit, { headers: { 'Content-Type': type } }).blob()
const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
async function settle(c: HTMLElement, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs
  while (!['ok', 'error'].includes(c.querySelector('[data-testid="artifact-card"], [data-testid="card"]')?.getAttribute('data-load') ?? '')) {
    if (Date.now() > end) throw new Error('timed out waiting for the card to load')
    await tick()
  }
}
const stored = (over: Partial<Artifact>): Artifact => ({ id: 'stored:files/out/x', path: 'out/x', kind: 'text', bytes: 10, source: 'stored', storedPath: 'files/out/x', href: '/runs/r1/artifacts/file?path=files%2Fout%2Fx', contentType: 'text/plain', encoding: 'utf-8', sha256: 'ab', ...over })

const TRACE = [
  '{"type":"tool.call","part":{"tool":"bash","args":{"cmd":"ls"}},"ts":1}',
  '{"type":"message.part","part":{"text":"I will now build the report from the CSV, then write the totals."},"ts":2}',
  '{"type":"broken", this is not json',
  '{"truncated":true,"reason":"maxFileBytes"}',
].join('\n') + '\n'

describe('Trace (agent/trace.jsonl)', () => {
  it('parseTrace: one row per line, a tool event, a text event, a broken line and the truncation marker', () => {
    const rows = parseTrace(TRACE)
    expect(rows.map((r) => [r.n, r.state])).toEqual([
      [1, 'ok'],
      [2, 'ok'],
      [3, 'broken'],
      [4, 'truncated'],
    ])
    expect(rows[0]!.summary).toBe('tool.call · bash')
    expect(rows[1]!.summary).toBe('message.part · I will now build the report from the CSV, then write the totals.')
    expect(rows[2]!.summary).toContain('this is not json')
    expect(rows[3]!.summary).toContain('truncated')
    expect(rows[3]!.summary).toContain('maxFileBytes')
    // The summary is cut at 160 chars; `message` is the third choice.
    expect(traceSummary({ type: 'x', message: 'm'.repeat(300) })).toHaveLength(160)
    expect(traceSummary({ type: 'x', message: 'm'.repeat(300) }).endsWith('…')).toBe(true)
    expect(traceSummary({ type: 'session.end' })).toBe('session.end')
    expect(traceSummary({ part: { text: 'no type' } })).toBe('(no type) · no type')
    expect(traceSummary([1, 2])).toBe('[1,2]')
    expect(parseTrace('')).toEqual([])
  })
  it('the list view shows the summaries, the raw fallback, the warning row, and a row expands to its JSON tree', () => {
    const c = mount(<TraceView text={TRACE} view="list" />)
    const rows = Array.from(c.querySelectorAll('[data-testid="trace-row"]'))
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['ok', 'ok', 'broken', 'truncated'])
    expect(rows[0]!.textContent).toContain('tool.call · bash')
    expect(rows[2]!.textContent).toContain('{"type":"broken", this is not json')
    expect(rows[3]!.getAttribute('role')).toBe('status')
    expect(rows[3]!.querySelector('.ra-warn')!.textContent).toContain('truncated')
    expect(c.querySelector('[data-testid="trace-detail"]')).toBeNull()
    click(rows[0]!.querySelector('[data-testid="trace-toggle"]'))
    const detail = rows[0]!.querySelector('[data-testid="trace-detail"]')!
    expect(detail).not.toBeNull()
    expect(detail.querySelector('[data-testid="json-tree"]')).not.toBeNull()
    expect(detail.textContent).toContain('object · 3 keys')
    // Raw = the text with line numbers.
    const raw = mount(<TraceView text={TRACE} view="raw" />)
    expect(raw.querySelectorAll('.ra-code__line')).toHaveLength(4)
    expect(raw.querySelector('.ra-code__n')!.textContent).toBe('1')
  })
  it('viewsOf: ndjson = List + Raw; a stored raster image = Image only; a stored SVG = Image + Source', () => {
    expect(viewsOf(stored({ kind: 'ndjson' })).map((v) => v.id)).toEqual(['list', 'raw'])
    expect(viewsOf(stored({ kind: 'image', contentType: 'image/png', encoding: 'base64' })).map((v) => v.id)).toEqual(['image'])
    expect(viewsOf(stored({ kind: 'image', contentType: 'image/svg+xml' })).map((v) => v.id)).toEqual(['image', 'source'])
    expect(viewsOf(stored({ kind: 'image', contentType: 'image/png', encoding: 'base64', diff: 'x' })).map((v) => v.id)).toEqual(['image', 'diff'])
  })
})

/** jsdom has no object URLs. Adds the two methods to the real URL (never replaces the constructor). */
function stubObjectUrl(value: string) {
  const create = vi.fn((_b: Blob) => value)
  const revoke = vi.fn()
  const u = URL as unknown as Record<string, unknown>
  u.createObjectURL = create
  u.revokeObjectURL = revoke
  return { create, revoke }
}

describe('Stored artifact card (L17)', () => {
  afterEach(() => {
    const u = URL as unknown as Record<string, unknown>
    delete u.createObjectURL
    delete u.revokeObjectURL
    vi.restoreAllMocks()
  })
  it('a raster image renders an <img> with a blob: src from the loaded Blob, and revokes it on unmount', async () => {
    const { create, revoke } = stubObjectUrl('blob:http://localhost/img-1')
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const loader = vi.fn(async () => blobOf(png, 'image/png'))
    const a = stored({ id: 'stored:files/out/chart.png', path: 'out/chart.png', storedPath: 'files/out/chart.png', kind: 'image', contentType: 'image/png', encoding: 'base64', bytes: 9876 })
    const c = mount(<ArtifactCard artifact={a} loader={loader} />)
    expect(c.querySelector('[data-testid="artifact-title"]')!.textContent).toBe('out/chart.png · 9.6 KB')
    await settle(c)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(loader).toHaveBeenCalledWith(a)
    const img = c.querySelector('[data-testid="image-view"] img')!
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('blob:http://localhost/img-1')
    expect(img.getAttribute('alt')).toBe('out/chart.png')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({ size: 4, type: 'image/png' })
    // The image is an <img> only: no <a href="blob:">, no iframe.
    expect(c.querySelectorAll('a[href^="blob:"]')).toHaveLength(0)
    expect(c.querySelector('iframe')).toBeNull()
    expect(revoke).not.toHaveBeenCalled()
    act(() => root!.unmount())
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/img-1')
  })
  it('an HTML card whose text comes from a stored Blob keeps sandbox="" and the CSP meta, and the loaded text decodes as UTF-8', async () => {
    const html = '<!doctype html><html><head><title>R</title></head><body><h1>Relatório ☕</h1></body></html>'
    const loader = vi.fn(async () => blobOf(new TextEncoder().encode(html), 'text/html'))
    const a = stored({ id: 'stored:files/out/report.html', path: 'out/report.html', storedPath: 'files/out/report.html', kind: 'html', contentType: 'text/html', bytes: 14537 })
    const c = mount(<ArtifactCard artifact={a} loader={loader} />)
    expect(c.querySelector('[data-testid="artifact-loading"]')).not.toBeNull()
    expect(c.querySelector('iframe')).toBeNull()
    await settle(c)
    const frame = c.querySelector('iframe[data-testid="html-preview-iframe"]')!
    expect(frame).not.toBeNull()
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('src')).toBeNull()
    const doc = frame.getAttribute('srcdoc')!
    expect(doc.startsWith('<!doctype html><html><head>' + CSP_META)).toBe(true)
    expect(doc).toContain('Relatório ☕')
    expect(c.querySelector('[data-testid="artifact-open"]')).not.toBeNull()
    expect(document.querySelectorAll('a[href^="blob:"], a[href^="data:text/html"]')).toHaveLength(0)
    expect(c.querySelector('[data-testid="artifact-stored-tag"]')).not.toBeNull()
  })
  it('the Download link saves the loaded Blob under the basename with an <a download>, then revokes the URL', async () => {
    const { revoke } = stubObjectUrl('blob:http://localhost/dl-1')
    vi.useFakeTimers()
    const clicked: Array<{ download: string; href: string; inDom: boolean }> = []
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href, inDom: this.isConnected })
    })
    const loader = vi.fn(async () => blobOf('{"ok":true}', 'application/json'))
    const a = stored({ id: 'stored:result.json', path: 'result.json', storedPath: 'result.json', kind: 'json', contentType: 'application/json', bytes: 11 })
    const c = mount(<ArtifactCard artifact={a} loader={loader} />)
    const dl = c.querySelector<HTMLButtonElement>('[data-testid="artifact-download"]')!
    expect(dl.disabled).toBe(true)
    expect(dl.getAttribute('data-filename')).toBe('result.json')
    const end = Date.now() + 2000
    while (c.querySelector('[data-testid="artifact-card"]')!.getAttribute('data-load') !== 'ok') {
      if (Date.now() > end) throw new Error('load')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
    }
    expect(c.querySelector('[data-testid="json-tree"]')).not.toBeNull()
    expect(dl.disabled).toBe(false)
    click(dl)
    expect(clicked).toEqual([{ download: 'result.json', href: 'blob:http://localhost/dl-1', inDom: true }])
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revoke).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/dl-1')
    clickSpy.mockRestore()
    vi.useRealTimers()
  })
  it('a loader error shows the status text in the card, and a collapsed card loads only when it opens', async () => {
    const { ApiError } = await import('../../lib/api/client')
    const loader = vi.fn(async () => {
      throw new ApiError(500, 'Internal Server Error')
    })
    const a = stored({ kind: 'text', path: 'agent/stderr.txt', storedPath: 'agent/stderr.txt', id: 'stored:agent/stderr.txt' })
    const c = mount(<ArtifactCard artifact={a} loader={loader} collapsible defaultOpen={false} />)
    await tick()
    expect(loader).not.toHaveBeenCalled()
    expect(c.querySelector('[data-testid="artifact-card"]')!.getAttribute('data-load')).toBe('idle')
    click(c.querySelector('[data-testid="artifact-toggle"]'))
    await settle(c)
    expect(loader).toHaveBeenCalledTimes(1)
    const err = c.querySelector('[data-testid="artifact-error"]')!
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toContain('HTTP 500')
    expect(err.textContent).toContain('Internal Server Error')
    expect(c.querySelector('[data-testid="text-view"]')).toBeNull()
    // Close and open again: no second request.
    click(c.querySelector('[data-testid="artifact-toggle"]'))
    click(c.querySelector('[data-testid="artifact-toggle"]'))
    await tick()
    expect(loader).toHaveBeenCalledTimes(1)
  })
  it('a stored text over 200 KB is collapsed with Show, and an NDJSON card opens on the list view', async () => {
    const big = 'x'.repeat(201 * 1024)
    const c = mount(<ArtifactCard artifact={stored({ kind: 'text', bytes: big.length })} loader={async () => blobOf(big, 'text/plain')} />)
    await settle(c)
    expect(c.querySelector('[data-testid="text-show"]')).not.toBeNull()
    const t = mount(<ArtifactCard artifact={stored({ id: 'stored:agent/trace.jsonl', path: 'agent/trace.jsonl', storedPath: 'agent/trace.jsonl', kind: 'ndjson', contentType: 'application/x-ndjson' })} loader={async () => blobOf(TRACE, 'application/x-ndjson')} />)
    await settle(t)
    expect(t.querySelector('[data-testid="trace-view"]')!.getAttribute('data-view')).toBe('list')
    expect(t.querySelectorAll('[data-testid="trace-row"]')).toHaveLength(4)
  })
})
