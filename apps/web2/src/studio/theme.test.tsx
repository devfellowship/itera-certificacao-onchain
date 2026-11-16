// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Chip, Dot, Kbd, Section, StuButton, Tab, Tabs, themeClass } from './theme'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
})

// vitest runs from apps/web2.
const css = readFileSync(join(process.cwd(), 'src/studio/theme.css'), 'utf8')

describe('studio theme css', () => {
  it('keeps every color hex in the token block', () => {
    const open = css.indexOf('.stu-theme {')
    const close = css.indexOf('\n}\n', open)
    const outside = css.slice(0, open) + css.slice(close)
    // The header comment is prose; strip comments before the check.
    expect(outside.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })

  it('carries the canvas values the redesign is judged against', () => {
    for (const [name, value] of Object.entries({ '--stu-bg': '#0a0908', '--stu-text': '#f6f1e7', '--stu-text-muted': '#887f71', '--stu-line': '#2a2622', '--stu-accent': '#3fd17f', '--stu-bad': '#e07a7a', '--stu-warn': '#e8c170', '--stu-merged': '#b48cf2' })) {
      expect(css).toContain(`${name}: ${value};`)
    }
  })

  it('carries the step-kind and avatar tokens of the S2, S3 and S9 artboards', () => {
    for (const [name, value] of Object.entries({ '--stu-k-read': '#8fb3e8', '--stu-k-search': '#b8a5e3', '--stu-k-test': '#7ad6cd', '--stu-k-tool': '#e3a5c7', '--stu-av-cc': '#4a3328', '--stu-av-cx': '#26302e', '--stu-av-oc': '#2a2a36', '--stu-av-al': '#1f3326' })) {
      expect(css).toContain(`${name}: ${value};`)
    }
    expect(css).toContain('--stu-k-write: var(--stu-warn);')
  })

  it('re-maps the app tokens only inside the .stu-theme scope', () => {
    const lines = css.split('\n').filter((l) => /^\s*--tma-[a-z-]+:/.test(l))
    expect(lines.length).toBeGreaterThan(10)
    const open = css.indexOf('.stu-theme {')
    const close = css.indexOf('\n}\n', open)
    expect(css.slice(0, open)).not.toMatch(/--tma-[a-z-]+:/)
    expect(css.slice(close)).not.toMatch(/^\s*--tma-[a-z-]+:/m)
  })
})

describe('studio theme components', () => {
  const mount = (node: React.ReactNode) => {
    const c = document.createElement('div')
    document.body.appendChild(c)
    root = createRoot(c)
    act(() => root!.render(node))
    return c
  }

  it('themeClass adds the scope class', () => {
    expect(themeClass('tma-page', false, 'x')).toBe('stu-theme tma-page x')
  })

  it('renders a section, a toggle chip, tabs, a button, a key hint and a dot', () => {
    const c = mount(
      <div>
        <Section title="Context" meta="judge cites 1" data-testid="sec">
          <Chip on data-testid="chip">A</Chip>
        </Section>
        <Tabs label="Judge">
          <Tab selected data-testid="tab-a">a</Tab>
          <Tab selected={false} data-testid="tab-b">b</Tab>
        </Tabs>
        <StuButton variant="primary" large data-testid="btn">
          Pass <Kbd>p</Kbd>
        </StuButton>
        <Dot tone="merged" />
      </div>,
    )
    expect(c.querySelector('h2.stu-section__title')?.textContent).toBe('Contextjudge cites 1')
    expect(c.querySelector('[data-testid=chip]')?.getAttribute('aria-pressed')).toBe('true')
    expect(c.querySelector('[data-testid=tab-a]')?.getAttribute('aria-selected')).toBe('true')
    expect(c.querySelector('[data-testid=tab-b]')?.getAttribute('aria-selected')).toBe('false')
    expect(c.querySelector('[role=tablist]')?.getAttribute('aria-label')).toBe('Judge')
    expect(c.querySelector('[data-testid=btn]')?.className).toBe('stu-btn stu-btn--primary stu-btn--lg')
    expect(c.querySelector('kbd.stu-kbd')?.textContent).toBe('p')
    expect(c.querySelector('.stu-dot--merged')).not.toBeNull()
  })
})
