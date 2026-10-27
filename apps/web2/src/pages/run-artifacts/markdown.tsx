/**
 * A small markdown renderer (plan TMA L14c). No dependency. It builds React elements, never an HTML
 * string, so every character of the input is text: `<script>` stays visible as text and no element
 * comes from the input. Covers headings, paragraphs, lists, code spans and fenced code, links
 * (http, https, mailto and relative hrefs only), emphasis, tables and blockquotes.
 */
import { Fragment, type ReactNode } from 'react'

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'code'; lang: string | null; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; start: number; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'hr' }

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** The href is kept only for http, https, mailto, or a relative path. Anything else (javascript:, data:, vbscript:) is dropped. */
export function safeHref(raw: string): string | null {
  const href = raw.replace(/[\u0000- \u007f]+/g, '').trim()
  if (!href) return null
  const m = SCHEME_RE.exec(href)
  if (!m) return href.startsWith('//') ? null : raw.trim()
  const scheme = m[0].slice(0, -1).toLowerCase()
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? raw.trim() : null
}

/* ---------- Block parser ---------- */

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0
  const para: string[] = []
  const flushPara = () => {
    if (para.length) {
      out.push({ t: 'p', text: para.join('\n') })
      para.length = 0
    }
  }
  while (i < lines.length) {
    const line = lines[i]!
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      flushPara()
      const close = fence[1]!
      const lang = fence[2] || null
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(close)) buf.push(lines[i++]!)
      i++ // the closing fence (or the end)
      out.push({ t: 'code', lang, text: buf.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      flushPara()
      out.push({ t: 'h', level: h[1]!.length, text: h[2]! })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara()
      out.push({ t: 'hr' })
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      flushPara()
      const buf: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      out.push({ t: 'quote', text: buf.join('\n') })
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        let item = lines[i++]!.replace(/^\s*[-*+]\s+/, '')
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*[-*+]\s+/.test(lines[i]!)) item += '\n' + lines[i++]!.trim()
        items.push(item)
      }
      out.push({ t: 'ul', items })
      continue
    }
    const ol = /^\s*(\d{1,9})[.)]\s+/.exec(line)
    if (ol) {
      flushPara()
      const items: string[] = []
      const start = Number(ol[1])
      while (i < lines.length && /^\s*\d{1,9}[.)]\s+/.test(lines[i]!)) {
        let item = lines[i++]!.replace(/^\s*\d{1,9}[.)]\s+/, '')
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*\d{1,9}[.)]\s+/.test(lines[i]!)) item += '\n' + lines[i++]!.trim()
        items.push(item)
      }
      out.push({ t: 'ol', start, items })
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      flushPara()
      const head = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') rows.push(splitRow(lines[i++]!))
      out.push({ t: 'table', head, rows })
      continue
    }
    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }
    para.push(line)
    i++
  }
  flushPara()
  return out
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
}

/* ---------- Inline parser ---------- */

const INLINE_RE = /(`+)([\s\S]*?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|~~([^~]+?)~~|!?\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|<(https?:\/\/[^\s>]+)>/g

export function renderInline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(...withBreaks(text.slice(last, idx), `${keyBase}${k++}`))
    const key = `${keyBase}${k++}`
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>)
    else if (m[3] !== undefined) out.push(<strong key={key}>{renderInline(m[3], key)}</strong>)
    else if (m[4] !== undefined) out.push(<strong key={key}>{renderInline(m[4], key)}</strong>)
    else if (m[5] !== undefined) out.push(<em key={key}>{renderInline(m[5], key)}</em>)
    else if (m[6] !== undefined) out.push(<em key={key}>{renderInline(m[6], key)}</em>)
    else if (m[7] !== undefined) out.push(<del key={key}>{renderInline(m[7], key)}</del>)
    else if (m[8] !== undefined) {
      const label = m[8]
      const href = safeHref(m[9] ?? '')
      const isImage = m[0].startsWith('!')
      if (isImage) out.push(<span key={key} className="md-img">[image: {label || m[9]}]</span>)
      else if (href) {
        out.push(
          <a key={key} href={href} rel="noopener noreferrer" target={SCHEME_RE.test(href) ? '_blank' : undefined}>
            {renderInline(label, key)}
          </a>,
        )
      } else out.push(<span key={key}>{renderInline(label, key)}</span>)
    } else if (m[10] !== undefined) {
      const href = safeHref(m[10])
      out.push(
        href ? (
          <a key={key} href={href} rel="noopener noreferrer" target="_blank">
            {m[10]}
          </a>
        ) : (
          <span key={key}>{m[10]}</span>
        ),
      )
    }
    last = idx + m[0].length
  }
  if (last < text.length) out.push(...withBreaks(text.slice(last), `${keyBase}${k++}`))
  return out
}

function withBreaks(text: string, key: string): ReactNode[] {
  const parts = text.split('\n')
  if (parts.length === 1) return [text]
  return parts.flatMap((p, i) => (i === 0 ? [p] : [<br key={`${key}b${i}`} />, p]))
}

/* ---------- Renderer ---------- */

/** Renders markdown as React elements. The output never carries an element from the input. */
export function renderMarkdown(src: string): ReactNode {
  const blocks = parseBlocks(src)
  return (
    <Fragment>
      {blocks.map((b, i) => {
        const key = `b${i}`
        switch (b.t) {
          case 'h': {
            const Tag = `h${Math.min(6, Math.max(1, b.level))}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
            return <Tag key={key}>{renderInline(b.text, key)}</Tag>
          }
          case 'p':
            return <p key={key}>{renderInline(b.text, key)}</p>
          case 'code':
            return (
              <pre key={key} data-lang={b.lang ?? undefined}>
                <code>{b.text}</code>
              </pre>
            )
          case 'ul':
            return (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}l${j}`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={key} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}l${j}`)}</li>
                ))}
              </ol>
            )
          case 'quote':
            return <blockquote key={key}>{renderMarkdown(b.text)}</blockquote>
          case 'table':
            return (
              <table key={key}>
                <thead>
                  <tr>
                    {b.head.map((h, j) => (
                      <th key={j}>{renderInline(h, `${key}h${j}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {b.head.map((_, c) => (
                        <td key={c}>{renderInline(r[c] ?? '', `${key}r${j}c${c}`)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          case 'hr':
            return <hr key={key} />
        }
      })}
    </Fragment>
  )
}
