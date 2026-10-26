// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useSearchParams } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatView, DetailTabs, FieldTable, JsonTree, PASS_LINE, ResultDot, ScoreBar, halfWidth, useTabParam, wilson90 } from './index'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
})
function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe('wilson90', () => {
  // Hand computation, z = 1.6449, z² = 2.70570. denom = 1 + z²/n. center = (p + z²/2n) / denom.
  // half = z · sqrt(p(1−p)/n + z²/4n²) / denom.
  it('5 of 5: center 0.8244, half 0.1756 → 64.9–100', () => {
    // n=5: z²/n = 0.54114, denom = 1.54114. center = (1 + 0.27057)/1.54114 = 0.82443.
    // half = 1.6449 · sqrt(0 + 0.027057)/1.54114 = 1.6449 · 0.16449/1.54114 = 0.17557. lo = 0.64887, hi = 1.0 (clamped).
    expect(wilson90(5, 5)).toEqual({ lo: 64.9, hi: 100 })
  })
  it('0 of 5: the mirror of 5 of 5 → 0–35.1', () => {
    // center = 0.27057/1.54114 = 0.17557; half = 0.17557. lo = 0 (clamped), hi = 0.35113.
    expect(wilson90(0, 5)).toEqual({ lo: 0, hi: 35.1 })
  })
  it('4 of 5: p=0.8 → 43.5–95.4', () => {
    // center = (0.8 + 0.27057)/1.54114 = 0.69466. half = 1.6449 · sqrt(0.032 + 0.027057)/1.54114
    // = 1.6449 · 0.24302/1.54114 = 0.25938. lo = 0.43528, hi = 0.95404.
    expect(wilson90(4, 5)).toEqual({ lo: 43.5, hi: 95.4 })
  })
  it('0 of 0 is null, and halfWidth follows', () => {
    expect(wilson90(0, 0)).toBeNull()
    expect(halfWidth(null)).toBeNull()
    expect(halfWidth(wilson90(4, 5))).toBe(26) // (95.4 − 43.5) / 2 = 25.95
    expect(halfWidth({ lo: 64.9, hi: 100 })).toBe(17.5)
  })
  it('PASS_LINE is 100 (ADR-5: every hidden check must pass)', () => {
    expect(PASS_LINE).toBe(100)
  })
})

describe('ScoreBar', () => {
  it('places the tick, the band and the pass line at the right percent and says the numbers', () => {
    const c = mount(<ScoreBar score={80} ci={{ lo: 51, hi: 94 }} />)
    const bar = c.querySelector('[role="img"]')!
    expect(bar.getAttribute('aria-label')).toBe('score 80, 90% CI 51–94, pass line 100')
    expect((c.querySelector('[data-testid="score-bar-tick"]') as HTMLElement).style.left).toBe('80%')
    const band = c.querySelector('[data-testid="score-bar-band"]') as HTMLElement
    expect(band.style.left).toBe('51%')
    expect(band.style.width).toBe('43%')
    expect((c.querySelector('[data-testid="score-bar-pass"]') as HTMLElement).style.left).toBe('100%')
  })
  it('renders no band without a CI, and a custom pass line and max', () => {
    const c = mount(<ScoreBar score={5} passLine={9} max={10} />)
    expect(c.querySelector('[data-testid="score-bar-band"]')).toBeNull()
    expect((c.querySelector('[data-testid="score-bar-tick"]') as HTMLElement).style.left).toBe('50%')
    expect((c.querySelector('[data-testid="score-bar-pass"]') as HTMLElement).style.left).toBe('90%')
    expect(c.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('score 5, pass line 9')
  })
  it('says "no score" for null', () => {
    const c = mount(<ScoreBar score={null} />)
    expect(c.querySelector('[data-testid="score-bar-tick"]')).toBeNull()
    expect(c.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('no score, pass line 100')
  })
})

describe('ResultDot', () => {
  it('maps outcomes to a word and a tone class', () => {
    const c = mount(
      <>
        <ResultDot outcome="PASS" />
        <ResultDot outcome="fail" />
        <ResultDot outcome="timeout" />
        <ResultDot outcome={null} />
      </>,
    )
    const dots = [...c.querySelectorAll('[data-testid="result-dot"]')]
    expect(dots.map((d) => d.textContent)).toEqual(['pass', 'fail', 'invalid', '—'])
    expect(dots[0]!.className).toContain('dt-result--pass')
    expect(dots[1]!.className).toContain('dt-result--fail')
  })
})

describe('ChatView', () => {
  it('renders bubbles, tool lines, the evidence class and the word evidence', () => {
    const c = mount(
      <ChatView
        messages={[
          { role: 'user', index: 'm1', text: 'Fix POST /events.' },
          { role: 'agent', index: 'demo', text: '2 tool calls' },
          { role: 'tool', text: 'read src/app.ts', ok: true },
          { role: 'tool', text: 'bash npm test', ok: false },
          { role: 'grader', index: 'done when', text: 'A second delivery changes nothing.', evidence: true },
        ]}
      />,
    )
    const msgs = [...c.querySelectorAll('[data-testid="chat-msg"]')]
    expect(msgs.map((m) => m.getAttribute('data-role'))).toEqual(['user', 'agent', 'grader'])
    expect(msgs[0]!.className).toContain('dt-chat__msg--user')
    expect(msgs[0]!.textContent).toContain('user')
    expect(msgs[0]!.textContent).toContain('m1')
    expect(msgs[0]!.textContent).toContain('Fix POST /events.')
    const tools = [...c.querySelectorAll('[data-testid="chat-tool"]')]
    expect(tools.map((t) => t.textContent)).toEqual(['read src/app.ts', 'bash npm test'])
    expect(tools[1]!.className).toContain('dt-chat__tool--bad')
    expect(msgs[2]!.className).toContain('dt-chat__msg--evidence')
    expect(msgs[2]!.querySelector('.dt-chat__evidence')?.textContent).toBe('evidence')
    expect(msgs[0]!.querySelector('.dt-chat__evidence')).toBeNull()
  })
})

describe('FieldTable', () => {
  it('renders one row per field with type, value and weight', () => {
    const c = mount(<FieldTable rows={[{ field: 'task_intent', type: 'enum', value: 'one of 4', weight: 10 }, { field: 'notes', value: 'free text' }]} />)
    const rows = [...c.querySelectorAll('[data-testid="field-row"]')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toBe('task_intentenumone of 410')
    expect(rows[1]!.querySelector('.dt-fields__w')?.textContent).toBe('—')
  })
})

describe('JsonTree', () => {
  it('shows object · N keys, expands and collapses', () => {
    const c = mount(<JsonTree value={{ a: 1, b: 'two', c: { d: true, e: null }, f: [1, 2, 3, 4] }} />)
    expect(c.textContent).toContain('object · 4 keys')
    expect(c.textContent).toContain('"two"')
    // Depth 1 nodes start collapsed: their summary shows, their children do not.
    expect(c.textContent).toContain('object · 2 keys')
    expect(c.textContent).toContain('array · 4 items')
    expect(c.textContent).not.toContain('true')
    const toggles = [...c.querySelectorAll('.dt-json__toggle')]
    click(toggles[1]!) // c
    expect(c.textContent).toContain('true')
    expect(c.textContent).toContain('null')
    click(c.querySelectorAll('.dt-json__toggle')[1]!) // collapse c again
    expect(c.textContent).not.toContain('true')
    click(toggles[0]!) // root
    expect(c.textContent).not.toContain('"two"')
    expect(c.textContent).toContain('object · 4 keys')
  })
})

function TabHost() {
  const [tab, setTab] = useTabParam(['overview', 'runs'] as const, 'overview')
  const [search] = useSearchParams()
  return (
    <>
      <DetailTabs items={[{ id: 'overview', label: 'Overview' }, { id: 'runs', label: 'Runs', count: 17 }]} value={tab} onChange={setTab} />
      <span data-testid="search">{search.toString()}</span>
    </>
  )
}

describe('useTabParam', () => {
  it('reads and writes ?tab= and keeps ?v=', () => {
    const c = mount(
      <MemoryRouter initialEntries={['/tasks/x?v=2&tab=runs']}>
        <TabHost />
      </MemoryRouter>,
    )
    expect(c.querySelector('[data-testid="detail-tabs"]')!.getAttribute('data-tab')).toBe('runs')
    expect(c.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Runs17')
    click(c.querySelectorAll('[role="tab"]')[0]!)
    expect(c.querySelector('[data-testid="detail-tabs"]')!.getAttribute('data-tab')).toBe('overview')
    expect(c.querySelector('[data-testid="search"]')!.textContent).toBe('v=2&tab=overview')
  })
  it('falls back for an unknown value', () => {
    const c = mount(
      <MemoryRouter initialEntries={['/tasks/x?tab=nope']}>
        <TabHost />
      </MemoryRouter>,
    )
    expect(c.querySelector('[data-testid="detail-tabs"]')!.getAttribute('data-tab')).toBe('overview')
  })
})
