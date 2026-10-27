// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { Artifact } from './artifacts'
import { safeHref } from './markdown'
import { ArtifactCard, CSP_META, DiffView, HtmlPreviewFrame, ImageView, JsonView, MarkdownView, TextView, injectCsp } from './renderers'

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
