// @vitest-environment jsdom
/**
 * S13 review queue (plan 20261112-tma-c6-judge-calibration, task T3). Mounted through routes.tsx with a stubbed API.
 * Proves: one run per screen in the API order (disagreement first), the summary, folded steps and both verdicts; a
 * reason chip plus Fail sends exactly {run_id, judge_id, pass, reason_code} and moves on; Defer writes nothing; the p
 * hotkey sends pass on the judge of ?judge=; the only non-GET call is POST /grader-results/human; the empty,
 * done and 503 states; the fold of a long step list.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import { foldSteps, type ReviewRun } from './studio/review'

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
  status: 'pass', startedAt: '2026-11-15T10:00:00.000Z', steps: [{ kind: 'read', ok: true }, { kind: 'shell', ok: false }],
  judge: null, workflow: null, mine: null, disagree: false, ...over,
})
const QUEUE = [run(R1, { disagree: true, judge: v(true), workflow: v(false, 'workflow:reverted') }), run(R2)]

interface Call { method: string; path: string; body: unknown }
const calls: Call[] = []
function mountAt(path: string, queue: [number, unknown] = [200, { judge: 'async-wait-lifecycle', runs: QUEUE }]) {
  saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.pathname === '/review-queue') return json(...queue)
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

describe('foldSteps', () => {
  it('keeps short lists and folds long ones to head, hidden count and tail', () => {
    expect(foldSteps([1, 2, 3])).toEqual({ head: [1, 2, 3], hidden: 0, tail: [] })
    const f = foldSteps(Array.from({ length: 40 }, (_, i) => i))
    expect(f.head).toHaveLength(12)
    expect(f.hidden).toBe(16)
    expect(f.tail[11]).toBe(39)
  })
})
