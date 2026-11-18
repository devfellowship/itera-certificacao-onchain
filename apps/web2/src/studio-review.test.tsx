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

// The serve URL is off by default (as in a build without VITE_TMA_STUDIO_SERVE_URL); the pin tests set it.
const serveState = vi.hoisted(() => ({ url: '' }))
vi.mock('./config', async (orig) => {
  const real = await orig<typeof import('./config')>()
  return {
    ...real,
    get STUDIO_SERVE_URL() {
      return serveState.url
    },
  }
})
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import { traceHref } from './studio/traces'
import { fmtDuration, foldSteps, gapBefore, type ReviewRun, type StepDetail } from './studio/review'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  progressAnswers = []
  pinAnswers = {}
  serveState.url = ''
  labelStrength = 'strong'
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
const PROGRESS = (test: { pass: number; fail: number }, judge = 'async-wait-lifecycle') => ({
  judge, floor: 30, splits: { test, dev: { pass: 0, fail: 0 }, train: { pass: 0, fail: 0 }, unknown: { pass: 0, fail: 0 } },
})
let progressAnswers: Array<[number, unknown]> = []
let pinAnswers: Record<string, [number, unknown]> = {}
let labelStrength: 'strong' | null = 'strong'
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
      if (url.host === '127.0.0.1:8799') {
        const m = /^\/v1\/pins\/([0-9a-f]{64})$/.exec(url.pathname)
        if (m && pinAnswers[m[1]!]) return json(...pinAnswers[m[1]!]!)
        return json(404, { error: 'pin_not_found' })
      }
      if (url.pathname === '/review-queue') return json(...queue)
      if (url.pathname === '/review-queue/steps') return json(...steps)
      if (url.pathname === '/review-queue/progress') {
        const judge = url.searchParams.get('judge')!
        return json(...(progressAnswers.shift() ?? [200, PROGRESS({ pass: 0, fail: 0 }, judge)]))
      }
      if (url.pathname === '/grader-results/human' && method === 'POST') {
        const b = JSON.parse(String(init!.body)) as object
        return json(201, { id: 'l1', ...b, labeler: labelStrength === 'strong' ? 'person:u-1' : 'user:u-1', strength: labelStrength })
      }
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
    // The whole queue: the API maximum, not the default of 50 (a short read showed "1 of 50" for a queue of 131).
    expect(calls.some((x) => x.path === '/review-queue?judge=async-wait-lifecycle&limit=200')).toBe(true)
    expect(q(c, 'review-card')!.dataset.runId).toBe(R1)
    expect(q(c, 'review-position')!.textContent).toBe('1 of 2')
    expect(q(c, 'review-disagree')).not.toBeNull()
    expect(q(c, 'review-summary')!.textContent).toContain('CI was red on the PR')
    expect(c.querySelectorAll('[data-testid="review-step"]')).toHaveLength(2)
    expect(q(c, 'review-judge')!.textContent).toBe('pass')
    expect(q(c, 'review-workflow')!.textContent).toBe('fail')
  })

  it('Fail writes one label with no reason and moves on; Defer writes nothing', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    click(q(c, 'review-fail'))
    await waitFor(() => q(c, 'review-card')?.dataset.runId === R2, 'second run')
    expect(writes()).toEqual([{ method: 'POST', path: '/grader-results/human', body: { run_id: R1, judge_id: 'async-wait-lifecycle', pass: false, reason_code: null } }])
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

  // Incident 2026-11-16: a member whose session predates the TMA_MIN_IAM_LEVEL gate (the login stored no level) got
  // 403 on every call and saw "The studio could not load this data". The API now answers 401 iam_level_unknown for that
  // session: the page must drop the stored session (the provider then signs in again, and the new exchange stores the level).
  it('drops a session that predates the member gate (401 iam_level_unknown) so the next exchange stores the level', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined) // jsdom: navigation to the federate URL is not implemented
    const c = mountAt('/studio/review', [401, { error: 'iam_level_unknown' }], [401, { error: 'iam_level_unknown' }])
    await waitFor(() => localStorage.getItem('tma2.session') === null, 'session cleared')
    expect(q(c, 'review-card')).toBeNull()
  })

  it('names the member gate on a 403 instead of the generic reload text', async () => {
    const c = mountAt('/studio/review', [403, { error: 'iam_level_too_low' }])
    await waitFor(() => !!q(c, 'review-error'), '403')
    expect(q(c, 'review-error')!.textContent).toContain('The studio is for DFL members.')
    expect(q(c, 'review-error')!.textContent).not.toContain('Reload the page')
    expect(localStorage.getItem('tma2.session')).not.toBeNull()
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

  it('keeps the keys: f sends fail, d defers without a write; 3 writes nothing', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' })))
    expect(writes()).toHaveLength(0)
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' })))
    await waitFor(() => writes().length === 1, 'write')
    expect(writes()[0]!.body).toEqual({ run_id: R1, judge_id: 'async-wait-lifecycle', pass: false, reason_code: null })
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

describe('S13 reviewer context (C6-REVIEW-QUEUE-READY)', () => {
  it('shows the rubric of the judge of the tab: the criterion, Pass when and Fail when, open by default', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    const rubric = q(c, 'review-rubric') as HTMLDetailsElement
    expect(rubric.open).toBe(true)
    expect(rubric.textContent).toContain('rubric 0.1.0')
    expect(q(c, 'review-rubric-pass')!.querySelectorAll('li')).toHaveLength(4)
    expect(q(c, 'review-rubric-fail')!.textContent).toContain('foreground sleep')
    act(() => root?.unmount())
    const d = mountAt('/studio/review?judge=external-block-handling')
    await waitFor(() => !!q(d, 'review-card'), 'card')
    expect(q(d, 'review-rubric-fail')!.textContent).toContain('merges past a red check')
    expect(q(d, 'review-rubric-pass')!.textContent).not.toContain('watcher')
  })

  it('names the split of the run, and shows nothing when the API does not know it', async () => {
    const c = mountAt('/studio/review', [200, { judge: 'async-wait-lifecycle', runs: [run(R1, { split: 'test' }), run(R2, { split: null })] }])
    await waitFor(() => !!q(c, 'review-card'), 'card')
    expect(q(c, 'review-split')!.textContent).toBe('test split')
    click(q(c, 'review-defer'))
    await waitFor(() => q(c, 'review-card')?.dataset.runId === R2, 'second run')
    expect(q(c, 'review-split')).toBeNull()
  })
})

describe('S13 progress per judge (C6-REVIEW-QUEUE-READY)', () => {
  it('shows x of 30 pass and x of 30 fail in the test split, and reads it again after a saved label', async () => {
    progressAnswers = [[200, PROGRESS({ pass: 3, fail: 1 })], [200, PROGRESS({ pass: 3, fail: 2 })]]
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-progress'), 'progress')
    expect(q(c, 'review-progress')!.textContent).toBe('test split: 3 of 30 pass · 1 of 30 fail')
    expect(calls.filter((x) => x.path === '/review-queue/progress?judge=async-wait-lifecycle')).toHaveLength(1)
    click(q(c, 'review-fail'))
    await waitFor(() => q(c, 'review-progress')?.textContent === 'test split: 3 of 30 pass · 2 of 30 fail', 'progress after save')
    expect(q(c, 'review-weak')).toBeNull()
  })

  it('reads the progress of the judge of the tab, and marks the floor when both counts reach it', async () => {
    progressAnswers = [[200, PROGRESS({ pass: 31, fail: 30 }, 'external-block-handling')]]
    const c = mountAt('/studio/review?judge=external-block-handling')
    await waitFor(() => !!q(c, 'review-progress'), 'progress')
    expect(calls.some((x) => x.path === '/review-queue/progress?judge=external-block-handling')).toBe(true)
    expect(q(c, 'review-progress')!.textContent).toBe('test split: 30 of 30 pass · 30 of 30 fail')
    expect(q(c, 'review-progress')!.className).toContain('stu-ok')
  })

  it('warns when a saved label is not a person label (it would not count)', async () => {
    labelStrength = null
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    click(q(c, 'review-pass'))
    await waitFor(() => !!q(c, 'review-weak'), 'weak warning')
    expect(q(c, 'review-weak')!.textContent).toContain('saved as user, not as a person')
  })

  it('shows no counter when the progress read fails, and the queue still works', async () => {
    progressAnswers = [[503, { error: 'schema_not_ready' }]]
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    expect(q(c, 'review-progress')).toBeNull()
  })
})

describe('S13 full trace and host summary (C6-REVIEW-QUEUE-READY)', () => {
  const PIN = 'a'.repeat(64)
  const SID = '0123abcd-0000-4000-8000-00000000000a'
  const lookup = (over: Record<string, unknown> = {}) => ({
    pin_sha256: PIN, session_id: SID, agent_id: 'a1b2', selection_day: '2026-11-14', task_name: 'Fix the red CI', identifier: 'DFL-1',
    task_summary: { before: 'Host before.', expected: 'Host expected.', outcome: null }, has_trajectory: true, ...over,
  })
  const noSummary = (id: string) => run(id, { originPinSha256: PIN, taskSummary: null })

  it('resolves the pin of the run on the serve: links the full trace and shows the host summary when the API has none', async () => {
    serveState.url = 'http://127.0.0.1:8799'
    pinAnswers[PIN] = [200, lookup()]
    const c = mountAt('/studio/review', [200, { judge: 'async-wait-lifecycle', runs: [noSummary(R1)] }])
    await waitFor(() => !!q(c, 'review-trace-link'), 'trace link')
    // MT-20 (#cc9362f): one URL per run, keyed by the trace id of the session and the agent.
    expect(q(c, 'review-trace-link')!.getAttribute('href')).toBe(traceHref(SID, 'a1b2'))
    expect(q(c, 'review-summary')!.dataset.source).toBe('host')
    expect(q(c, 'review-summary')!.textContent).toContain('Host expected.')
    expect(q(c, 'review-task-name')!.textContent).toBe('Fix the red CI')
    expect(q(c, 'review-summary-host')).not.toBeNull()
    // Parent ADR-1: the serve answer never goes to the TMA API.
    expect(calls.filter((x) => !x.path.startsWith('/v1/') && JSON.stringify(x).includes('Host'))).toEqual([])
  })

  it('keeps the API summary when the run has one, and links no trace when the session has no trajectory', async () => {
    serveState.url = 'http://127.0.0.1:8799'
    pinAnswers[PIN] = [200, lookup({ has_trajectory: false })]
    const c = mountAt('/studio/review', [200, { judge: 'async-wait-lifecycle', runs: [run(R1, { originPinSha256: PIN })] }])
    await waitFor(() => !!q(c, 'review-task-name'), 'lookup')
    expect(q(c, 'review-summary')!.dataset.source).toBe('api')
    expect(q(c, 'review-summary')!.textContent).toContain('CI was red on the PR')
    expect(q(c, 'review-trace-link')).toBeNull()
  })

  it('says why there is no trace link when the serve does not answer (off the tailnet)', async () => {
    serveState.url = 'http://127.0.0.1:8799'
    const c = mountAt('/studio/review', [200, { judge: 'async-wait-lifecycle', runs: [noSummary(R1)] }])
    await waitFor(() => !!q(c, 'review-trace-unavailable'), 'unavailable text')
    expect(q(c, 'review-trace-unavailable')!.textContent).toContain('not in the index')
    expect(q(c, 'review-summary')!.dataset.source).toBe('none')
  })

  it('asks the serve nothing when the build has no serve URL', async () => {
    const c = mountAt('/studio/review', [200, { judge: 'async-wait-lifecycle', runs: [noSummary(R1)] }])
    await waitFor(() => !!q(c, 'review-card'), 'card')
    expect(calls.some((x) => x.path.startsWith('/v1/'))).toBe(false)
  })
})

describe('S13 back and relabel (C6-REVIEW-QUEUE-READY)', () => {
  it('has no Back on the first run; after a label, Back (and u) shows that run with the saved verdict, and a new answer writes a newer label', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    expect(q(c, 'review-back')).toBeNull()
    click(q(c, 'review-fail'))
    await waitFor(() => q(c, 'review-card')?.dataset.runId === R2, 'second run')
    expect(q(c, 'review-back')).not.toBeNull()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u' })))
    await waitFor(() => q(c, 'review-card')?.dataset.runId === R1, 'back to the first run')
    expect(q(c, 'review-saved')!.textContent).toBe('saved: fail')
    expect(q(c, 'review-relabel-note')).not.toBeNull()
    click(q(c, 'review-pass'))
    await waitFor(() => writes().length === 2, 'second write')
    expect(writes().map((w) => (w.body as { pass: boolean }).pass)).toEqual([false, true])
    await waitFor(() => q(c, 'review-card')?.dataset.runId === R2, 'forward again')
  })

  it('the done card goes back to the last run, and Start again reads the queue again', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    click(q(c, 'review-defer'))
    await waitFor(() => q(c, 'review-card')?.dataset.runId === R2, 'second run')
    click(q(c, 'review-defer'))
    await waitFor(() => !!q(c, 'review-done'), 'done')
    click(q(c, 'review-done-back'))
    await waitFor(() => q(c, 'review-card')?.dataset.runId === R2, 'back from done')
    click(q(c, 'review-defer'))
    await waitFor(() => !!q(c, 'review-done'), 'done again')
    const before = calls.filter((x) => x.path.startsWith('/review-queue?')).length
    click(q(c, 'review-restart'))
    await waitFor(() => calls.filter((x) => x.path.startsWith('/review-queue?')).length === before + 1, 'queue read again')
    await waitFor(() => q(c, 'review-card')?.dataset.runId === R1, 'first run')
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

  it('shows no reason chips: the closed API codes (wrong SHA, no check) belong to another check', async () => {
    const c = mountAt('/studio/review')
    await waitFor(() => !!q(c, 'review-card'), 'card')
    expect(c.querySelector('[data-testid^="review-reason-"]')).toBeNull()
    expect(c.textContent).not.toContain('Checked the wrong SHA')
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
