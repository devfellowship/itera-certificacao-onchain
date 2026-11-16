// @vitest-environment jsdom
/**
 * S13 review queue (plan 20261112-tma-c6-judge-calibration, task T3). Mounted through routes.tsx with a stubbed API.
 * Proves: one run per screen in the API order (disagreement first), the summary, folded steps and both verdicts; a
 * reason chip plus Fail sends exactly {run_id, judge_id, pass, reason_code} and moves on; Defer writes nothing; the p
 * hotkey sends pass on the judge of ?judge=; the only non-GET call is POST /grader-results/human; the empty,
 * done and 503 states; the fold of a long step list.
 */
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import { fmtDuration, foldSteps, gapBefore, type ReviewRun, type StepDetail } from './studio/review'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
async function waitFor(check: () => boolean, label: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const R1 = '1b6f3c2e-1d4a-4c8e-9f00-123456789abc'
const R2 = '2b6f3c2e-1d4a-4c8e-9f00-123456789abc'
const v = (pass: boolean, labeler: string | null = null) => ({ pass, labeler, gradedAt: '2026-11-15T10:00:00.000Z' })
const run = (id: string, over: Partial<ReviewRun> = {}): ReviewRun => ({
  runId: id, caseKey: `case-${id.slice(0, 4)}`, useCaseKey: 'build/feature', originPinSha256: null,
  taskSummary: { before: 'CI was red on the PR', expected: 'The PR merges with green CI' }, modelId: 'anthropic/claude-opus-5.5',
  status: 'pass', startedAt: '2026-11-15T10:00:00.000Z', steps: [{ seq: 1, kind: 'read', ok: true }, { seq: 2, kind: 'shell', ok: false }],
  judge: null, workflow: null, mine: null, disagree: false, ...over,
})
const QUEUE = [run(R1, { disagree: true, judge: v(true), workflow: v(false, 'workflow:reverted') }), run(R2)]

interface Call { method: string; path: string; body: unknown }
const calls: Call[] = []
const STEPS: StepDetail[] = [
  { seq: 1, tool: 'Bash', target: 'gh pr view', kind: 'read', status: 'ok', errorClass: null, durationMs: 1200, startedMs: 0, turnOrigin: 'agent' },
  { seq: 2, tool: 'Bash', target: 'gh run watch', kind: 'shell', status: 'error', errorClass: 'tool_error', durationMs: 4000, startedMs: 200_000, turnOrigin: 'agent' },
]
function mountAt(
  path: string,
  queue: [number, unknown] = [200, { judge: 'async-wait-lifecycle', runs: QUEUE }],
  steps: [number, unknown] = [200, { run_id: R1, steps: STEPS }],
) {
  saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.pathname === '/review-queue') return json(...queue)
      if (url.pathname === '/review-queue/steps') return json(...steps)
      if (url.pathname === '/grader-results/human' && method === 'POST') return json(201, { id: 'l1', ...(JSON.parse(String(init!.body)) as object) })
      return json(404, { error: 'not found' })
    }),
  )
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />))
  return c
}
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = (el: HTMLElement | null) => act(() => el!.click())
const writes = () => calls.filter((x) => x.method !== 'GET')

describe('S13 review queue', () => {
  it('shows one run per screen with summary, folded steps and both verdicts', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    expect(calls.some((x) => x.path === '/review-queue?judge=async-wait-lifecycle')).toBe(true)
    expect(q(c, 'review-card')!.dataset.runId).toBe(R1)
    expect(q(c, 'review-position')!.textContent).toBe('1 of 2')
    expect(q(c, 'review-disagree')).not.toBeNull()
    expect(q(c, 'review-summary')!.textContent).toContain('CI was red on the PR')
    expect(c.querySelectorAll('[data-testid="review-step"]')).toHaveLength(2)
    expect(q(c, 'review-judge')!.textContent).toBe('pass')
    expect(q(c, 'review-workflow')!.textContent).toBe('fail')
  })

  it('a reason chip plus Fail writes one closed label and moves on; Defer writes nothing', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    click(q(c, 'review-reason-partial'))
    click(q(c, 'review-fail'))
    await waitFor(() => q(c, 'review-card')?.dataset.runId === R2, 'second run')
    expect(writes()).toEqual([{ method: 'POST', path: '/grader-results/human', body: { run_id: R1, judge_id: 'async-wait-lifecycle', pass: false, reason_code: 'partial' } }])
    click(q(c, 'review-defer'))
    await waitFor(() => !!q(c, 'review-done'), 'done')
    expect(writes()).toHaveLength(1)
    expect(q(c, 'review-done')!.textContent).toContain('1 label(s)')
  })

  it('the p hotkey writes pass with no reason', async () => {
    const c = mountAt('/studio/review?judge=external-block-handling')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' })))
    await waitFor(() => writes().length === 1, 'write')
    expect(writes()[0]!.body).toEqual({ run_id: R1, judge_id: 'external-block-handling', pass: true, reason_code: null })
  })

  it('shows the empty and the 503 states', async () => {
    const c = mountAt('/studio/review', [200, { judge: 'async-wait-lifecycle', runs: [] }])
    await waitFor(() => !!q(c, 'review-empty'), 'empty')
    act(() => root?.unmount())
    const d = mountAt('/studio/review', [503, { error: 'schema_not_ready' }])
    await waitFor(() => !!q(d, 'review-error'), '503')
    expect(q(d, 'review-error')!.textContent).toContain('not migrated')
  })
})

describe('S13 canvas layout (UI-S13)', () => {
  it('opts in to the studio theme and follows the artboard: judge tabs, the question as the title, sections, a 3-button grade bar', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    expect(q(c, 'studio-review')!.classList.contains('stu-theme')).toBe(true)
    const tabs = c.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')
    expect([...tabs].map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    expect(q(c, 'review-judge-async-wait-lifecycle')).toBe(tabs[0])
    expect(c.querySelector('h1')!.textContent).toBe('Waits use a watcher, not polling in the session?')
    expect(q(c, 'review-card')!.contains(c.querySelector('h1'))).toBe(true)
    const titles = [...c.querySelectorAll('h2.stu-section__title')].map((h) => h.firstChild?.textContent)
    expect(titles).toEqual(['Context', 'Last 4 calls', 'Judge says'])
    expect(c.querySelector('.rvw-actions')!.querySelectorAll('button')).toHaveLength(3)
    expect(q(c, 'review-pass')!.className).toContain('stu-btn--primary')
    expect(c.querySelector('[role="tooltip"]')!.textContent).toContain('teaches and checks the AI judge')
  })

  it('lists the last calls of the run under the section, from the steps endpoint, with the failed one marked', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-last-calls'), 'last calls')
    const rows = [...c.querySelectorAll('[data-testid="review-last-calls"] li')]
    expect(rows.map((r) => r.textContent)).toEqual(['Bashgh pr view', 'Bashgh run watcherror'])
    expect(rows[1]!.className).toContain('rvw-call--bad')
    expect(calls.filter((x) => x.path.startsWith('/review-queue/steps')).length).toBe(1)
  })

  it('keeps the keys: 1-4 pick a reason (aria-pressed), f sends fail with it, d defers without a write', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' })))
    expect(q(c, 'review-reason-partial')!.getAttribute('aria-pressed')).toBe('true')
    expect(q(c, 'review-reason-no_check')!.getAttribute('aria-pressed')).toBe('false')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' })))
    await waitFor(() => writes().length === 1, 'write')
    expect(writes()[0]!.body).toEqual({ run_id: R1, judge_id: 'async-wait-lifecycle', pass: false, reason_code: 'partial' })
    await waitFor(() => q(c, 'review-card')?.dataset.runId === R2, 'second run')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' })))
    await waitFor(() => !!q(c, 'review-done'), 'done')
    expect(writes()).toHaveLength(1)
  })

  it('verdicts carry the word, not only a color', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    expect(q(c, 'review-judge')!.parentElement!.className).toContain('stu-ok')
    expect(q(c, 'review-workflow')!.parentElement!.className).toContain('stu-bad')
    expect(q(c, 'review-workflow')!.textContent).toBe('fail')
  })
})

describe('S13 step detail', () => {
  it('a click on a step box opens the detail of that step: tool, target, result, timing and the idle time before it', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    expect(q(c, 'review-step-detail')).toBeNull()
    click(c.querySelectorAll<HTMLElement>('[data-testid="review-step"]')[1]!)
    await waitFor(() => !!q(c, 'review-step-open'), 'detail')
    expect(calls.filter((x) => x.path.startsWith('/review-queue/steps')).map((x) => x.path)).toEqual([`/review-queue/steps?run_id=${R1}`])
    const open = q(c, 'review-step-open')!
    expect(open.textContent).toContain('#2')
    expect(open.textContent).toContain('gh run watch')
    expect(open.textContent).toContain('tool_error')
    expect(open.textContent).toContain('4.0 s')
    expect(open.textContent).toContain('3 min 19 s')
    expect(c.querySelectorAll('[data-testid="review-step-row"]')).toHaveLength(2)
    expect(q(c, 'review-step-idle-long')!.textContent).toContain('3 min 19 s')
    expect(q(c, 'review-step-long')).toBeNull()
    expect(c.querySelectorAll<HTMLElement>('[data-testid="review-step"]')[1]!.getAttribute('aria-pressed')).toBe('true')
    // The only writes stay the label: opening a step writes nothing.
    expect(writes()).toEqual([])
  })
  it('a step that ran for 30 s or more is marked, so a wait inside one step is visible without timestamps', async () => {
    const c = mountAt('/studio/review', [200, { judge: 'async-wait-lifecycle', runs: QUEUE }], [200, { run_id: R1, steps: [{ ...STEPS[0]!, durationMs: 600_000, startedMs: null }, { ...STEPS[1]!, startedMs: null }] }])
    await waitFor(() => !!q(c, 'review-card'), 'card')
    click(q(c, 'review-steps-toggle'))
    await waitFor(() => !!q(c, 'review-step-long'), 'long marker')
    expect(q(c, 'review-step-long')!.textContent).toContain('ran 10 min')
    expect(q(c, 'review-step-idle-long')).toBeNull()
  })
  it('the toggle opens the whole timeline without a selected step, and a row selects its step', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    click(q(c, 'review-steps-toggle'))
    await waitFor(() => c.querySelectorAll('[data-testid="review-step-row"]').length === 2, 'rows')
    expect(q(c, 'review-step-open')).toBeNull()
    click(c.querySelectorAll<HTMLElement>('[data-testid="review-step-row"] button')[0]!)
    expect(q(c, 'review-step-open')!.textContent).toContain('gh pr view')
  })
  it('a failed steps request shows a message, not an empty box', async () => {
    const c = mountAt('/studio/review', [200, { judge: 'async-wait-lifecycle', runs: QUEUE }], [403, { error: 'iam_level_too_low' }])
    await waitFor(() => !!q(c, 'review-card'), 'card')
    click(c.querySelectorAll<HTMLElement>('[data-testid="review-step"]')[0]!)
    await waitFor(() => !!q(c, 'review-step-error'), 'error')
    expect(q(c, 'review-step-error')!.textContent!.length).toBeGreaterThan(10)
  })
})

describe('step timing helpers', () => {
  it('formats durations and the idle time between steps', () => {
    expect(fmtDuration(null)).toBeNull()
    expect(fmtDuration(250)).toBe('250 ms')
    expect(fmtDuration(1200)).toBe('1.2 s')
    expect(fmtDuration(45_000)).toBe('45 s')
    expect(fmtDuration(190_000)).toBe('3 min 10 s')
    expect(fmtDuration(3_900_000)).toBe('1 h 5 min')
    const a = { ...STEPS[0]!, startedMs: 1000, durationMs: 500 }
    expect(gapBefore(a, { ...STEPS[1]!, startedMs: 61_500 })).toBe(60_000)
    expect(gapBefore(a, { ...STEPS[1]!, startedMs: null })).toBeNull()
    expect(gapBefore(undefined, STEPS[1]!)).toBeNull()
    expect(gapBefore(a, { ...STEPS[1]!, startedMs: 900 })).toBe(0)
  })
})

describe('foldSteps', () => {
  it('keeps short lists and folds long ones to head, hidden count and tail', () => {
    expect(foldSteps([1, 2, 3])).toEqual({ head: [1, 2, 3], hidden: 0, tail: [] })
    const f = foldSteps(Array.from({ length: 40 }, (_, i) => i))
    expect(f.head).toHaveLength(12)
    expect(f.hidden).toBe(16)
    expect(f.tail[11]).toBe(39)
  })
})

/** The cascade of the two stylesheets for an element with these classes, by specificity (class count) only. jsdom does not load the CSS. */
const CSS_FILES = ['studio/theme.css', 'studio/studio.css'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
function winning(classes: string[], prop: string): { value: string | null; ties: number } {
  const hits: Array<{ spec: number; value: string }> = []
  for (const css of CSS_FILES) {
    // Top-level rules of a compound of classes only (a rule inside @media is skipped).
    for (const m of css.matchAll(/(?<=^|})\s*((?:\.[\w-]+)+)\s*\{([^}]*)\}/g)) {
      const own = m[1]!.split('.').filter(Boolean)
      if (!own.every((x) => classes.includes(x))) continue
      const d = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(m[2]!)
      if (d) hits.push({ spec: own.length, value: d[1]!.trim() })
    }
  }
  if (hits.length === 0) return { value: null, ties: 0 }
  const top = Math.max(...hits.map((h) => h.spec))
  const best = hits.filter((h) => h.spec === top)
  return { value: best[best.length - 1]!.value, ties: best.length - 1 }
}
/** The left side of a 2-value shorthand (`vertical horizontal`) in px; `null` (no rule) is 0. */
const leftPx = (v: string | null) => (v === null ? 0 : parseInt(v.split(/\s+(?![^(]*\))/)[1]!, 10))

describe('S13 fixes from the UI judge (UI-S13-FIX)', () => {
  it('the failed-call row lines up with the other rows: its margin and padding cancel, and no rule ties on specificity', () => {
    const ok = ['stu-row', 'rvw-call']
    const bad = ['stu-row', 'rvw-call', 'rvw-call--bad']
    for (const prop of ['padding', 'margin']) expect(winning(bad, prop).ties, `${prop} ties`).toBe(0)
    const left = (c: string[]) => leftPx(winning(c, 'margin').value) + leftPx(winning(c, 'padding').value)
    expect(left(ok)).toBe(0)
    expect(left(bad)).toBe(left(ok))
    expect(leftPx(winning(bad, 'padding').value)).toBe(10)
  })

  it('hides the key hints on a touch screen: hover none or a coarse pointer', () => {
    const css = CSS_FILES.join('\n')
    expect(css).toMatch(/@media\s*\(hover:\s*none\)\s*,\s*\(pointer:\s*coarse\)\s*\{[^}]*\.stu-kbd--keyboard\s*\{\s*display:\s*none/)
  })

  it('the reason chips read as the artboard and keep their codes', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    const chip = (code: string) => q(c, `review-reason-${code}`)!.textContent!.replace(/^\d\s*/, '')
    expect(chip('wrong_sha')).toBe('Checked the wrong SHA')
    expect(chip('no_check')).toBe('No check at all')
    expect(chip('partial')).toBe('Check was partial')
    expect(chip('other')).toBe('Other')
  })

  it('the info control is one button with a name, and the tip wrapper adds no second tab stop', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    const info = c.querySelector<HTMLElement>('.rvw-info')!
    expect(info.tagName).toBe('BUTTON')
    expect(info.getAttribute('type')).toBe('button')
    expect(info.getAttribute('aria-label')).toBe('What your answer does')
    expect(info.closest('.tma-tip')!.hasAttribute('tabindex')).toBe(false)
    expect(info.closest('.tma-tip')!.getAttribute('aria-describedby')).toBe(c.querySelector('[role="tooltip"]')!.id)
  })

  it('the meta line keeps the model id in its own span with the full id as title, and the queue count stays', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    const model = q(c, 'review-meta')!.querySelector<HTMLElement>('.rvw-meta__model')!
    expect(model.textContent).toBe('anthropic/claude-opus-5.5')
    expect(model.title).toBe('anthropic/claude-opus-5.5')
    expect(q(c, 'review-meta')!.querySelector('.rvw-meta__case')!.textContent).toContain('build/feature')
    expect(q(c, 'review-position')!.textContent).toBe('1 of 2')
    expect(q(c, 'review-position')!.closest('header')!.querySelector('[role="tablist"]')).not.toBeNull()
  })
})
