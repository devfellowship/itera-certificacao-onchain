// @vitest-environment jsdom
/**
 * S11 judge calibration and S11a AI judge (plan 20261112-tma-c6-judge-calibration, task T6). Mounted through routes.tsx
 * with a stubbed API. Proves: both judges are listed; the newest measured version shows TPR, TNR, the interval, the 2x2
 * counts and the split sizes; the bar reads 90 %; a rate under 0.90 or a split under the floor is "side signal only"; a
 * judge with no version shows an empty state; a model outside the A11 Q1 = B list is never printed; there is no Save or any
 * write control and the only calls are GET.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import { ALLOWED_JUDGE_MODELS, calibrateCommand, intervalText, modelAllowed, passesBar, shownModel, splitCheck, versionsOf, wilson } from './studio/calibration'
import type { GraderVersionDetail, GraderVersionItem } from './studio/graders'

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

const SHA = 'abcdef0123456789'.repeat(4)
const J1 = 'async-wait-lifecycle'
const J2 = 'external-block-handling'
const item = (id: string, graderId: string, semver: string, kind: GraderVersionItem['kind'], createdAt: string, usedByCount = 0, model: string | null = null): GraderVersionItem => ({
  id, graderId, semver, kind, codeSha256: SHA, judgeModelId: model, createdAt, usedByCount,
})
const detail = (i: GraderVersionItem, over: Partial<GraderVersionDetail> = {}): GraderVersionDetail => ({
  ...i, rubricSha256: SHA, paramsSha256: SHA.split('').reverse().join(''), testSplitSha256: SHA, tpr: null, tnr: null, proof: null, calibration: null, note: null, author: null, recentRuns: [], ...over,
})

const J1_V1 = item('v-1', J1, '0.1.0', 'judge', '2026-11-10T10:00:00.000Z', 0, 'anthropic/claude-sonnet-5.5')
const J1_V2 = item('v-2', J1, '0.2.0', 'judge', '2026-11-14T10:00:00.000Z', 0, 'anthropic/claude-sonnet-5.5')
const L1 = item('l-1', `label-${J1}`, '1.0.0', 'human', '2026-11-16T10:00:00.000Z', 22)
const L2 = item('l-2', `label-${J2}`, '1.0.0', 'human', '2026-11-16T10:00:00.000Z', 12)
const OTHER = item('c-1', 'hidden-tests', '0.3.0', 'code', '2026-11-14T10:00:00.000Z', 1)

// 28 of 30 pass labels judged pass (TPR 0.933); 27 of 30 fail labels judged fail (TNR 0.9).
const D_V2 = detail(J1_V2, { tpr: 28 / 30, tnr: 27 / 30, calibration: { nLabels: 120, nTest: 60, tp: 28, fn: 2, tn: 27, fp: 3, realignedAt: '2026-11-15T07:15:00Z' } })
const D_V1 = detail(J1_V1, { tpr: 0.8, tnr: 0.7, calibration: { nLabels: 60, nTest: 20, tp: 8, fn: 2, tn: 7, fp: 3, realignedAt: null } })

const wf = (pass: boolean) => ({ pass, labeler: 'workflow:clean-merge', gradedAt: '2026-11-16T10:00:00.000Z' })
const runs = (n: number, withWorkflow: number) =>
  Array.from({ length: n }, (_, i) => ({ runId: `r-${i}`, steps: [], judge: null, workflow: i < withWorkflow ? wf(true) : null, mine: null }))

interface Call { method: string; path: string }
const calls: Call[] = []
function mountAt(path: string, opts: { list?: [number, unknown]; details?: GraderVersionDetail[]; queue?: [number, unknown] } = {}) {
  saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
  calls.length = 0
  const list = opts.list ?? [200, { graderVersions: [OTHER, L1, L2, J1_V1, J1_V2] }]
  const details = opts.details ?? [D_V1, D_V2]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search })
      if (url.pathname === '/grader-versions') return json(...list)
      const m = /^\/grader-versions\/(.+)$/.exec(url.pathname)
      if (m) {
        const d = details.find((x) => x.id === m[1])
        return d ? json(200, d) : json(404, { error: 'grader version not found' })
      }
      if (url.pathname === '/review-queue') {
        if (opts.queue) return json(...opts.queue)
        const judge = url.searchParams.get('judge')
        return json(200, { judge, runs: judge === J1 ? runs(31, 12) : runs(32, 12) })
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
const text = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`)?.textContent ?? null
const FORBIDDEN = /\b(Save|Save as|Duplicate|Publish|Delete)\b/i

describe('calibration helpers', () => {
  it('wilson interval: known values, bounds and the empty case', () => {
    const i = wilson(28, 30)!
    expect(i.lo).toBeGreaterThan(0.78)
    expect(i.lo).toBeLessThan(0.79)
    expect(i.hi).toBeGreaterThan(0.98)
    expect(i.hi).toBeLessThan(0.99)
    expect(wilson(0, 0)).toBeNull()
    expect(wilson(5, 3)).toBeNull()
    expect(wilson(30, 30)!.hi).toBe(1)
    expect(wilson(0, 30)!.lo).toBe(0)
    expect(intervalText(null)).toContain('no interval')
  })
  it('a model outside the A11 Q1 = B list is never printed; local routes are allowed', () => {
    expect(ALLOWED_JUDGE_MODELS).not.toContain('openai/gpt-5-mini')
    expect(modelAllowed('anthropic/claude-sonnet-5.5')).toBe(true)
    expect(modelAllowed('ollama/qwen3')).toBe(true)
    expect(modelAllowed('openai/gpt-5-mini')).toBe(false)
    expect(shownModel('openai/gpt-5-mini')).not.toContain('gpt')
    expect(shownModel('anthropic/claude-sonnet-5.5')).toBe('anthropic/claude-sonnet-5.5')
    expect(shownModel(null)).toBe('not recorded')
  })
  it('the bar is 0.90 on both rates; the split floor is 30 pass and 30 fail', () => {
    expect(passesBar({ tpr: 0.9, tnr: 0.9 })).toBe(true)
    expect(passesBar({ tpr: 0.89, tnr: 0.95 })).toBe(false)
    expect(passesBar({ tpr: null, tnr: 1 })).toBe(false)
    expect(splitCheck({ nLabels: 90, nTest: 60, tp: 28, fn: 2, tn: 27, fp: 3, realignedAt: null })).toEqual({ pass: 30, fail: 30, clean: true })
    expect(splitCheck({ nLabels: 90, nTest: 59, tp: 28, fn: 1, tn: 27, fp: 3, realignedAt: null }).clean).toBe(false)
  })
  it('versionsOf keeps the judge kind of one judge, oldest first; the human label grader is not a version', () => {
    expect(versionsOf([J1_V2, L1, OTHER, J1_V1], J1).map((x) => x.semver)).toEqual(['0.1.0', '0.2.0'])
    expect(versionsOf([L1], J1)).toEqual([])
    expect(versionsOf([item('x', J1, '9.9.9', 'code', '2026-11-16T10:00:00.000Z')], J1)).toEqual([])
    expect(calibrateCommand(J1, '0.2.0', 'anthropic/claude-sonnet-5.5')).toBe(`tma eval judge calibrate --judge ${J1} --version 0.2.0 --model anthropic/claude-sonnet-5.5`)
    expect(calibrateCommand(J1, '0.2.0', 'openai/gpt-5-mini')).toContain('<model id>')
  })
})

describe('S11 /studio/calibration', () => {
  it('lists both judges with the newest version measured against the 90 % bar', async () => {
    const c = mountAt('/studio/calibration')
    await waitFor(() => c.querySelectorAll('[data-testid="calibration-judge"]').length === 2 && !!c.querySelector('[data-testid="cal-measured"]'), 'both judges')
    const cards = [...c.querySelectorAll('[data-testid="calibration-judge"]')]
    expect(cards.map((x) => x.getAttribute('data-judge'))).toEqual([J1, J2])
    const a = cards[0]!
    expect(a.querySelector('[data-testid="cal-to-review"]')?.textContent).toBe('31')
    expect(a.querySelector('[data-testid="cal-workflow-labels"]')?.textContent).toBe('12')
    expect(a.querySelector('[data-testid="cal-label-rows"]')?.textContent).toBe('22')
    expect(a.querySelector('[data-testid="cal-version"]')?.textContent).toBe(`${J1}@0.2.0`)
    expect(a.querySelector('[data-testid="cal-tpr-value"]')?.textContent).toBe('93.3%')
    expect(a.querySelector('[data-testid="cal-tnr-value"]')?.textContent).toBe('90%')
    expect(a.querySelector('[data-testid="cal-tpr-bar-text"]')?.textContent).toBe('bar 90%')
    expect(a.querySelector('[data-testid="cal-tpr-interval"]')?.textContent).toMatch(/^95% interval \d+(\.\d)?% to \d+(\.\d)?%$/)
    expect([...['cal-tp', 'cal-fn', 'cal-fp', 'cal-tn']].map((id) => a.querySelector(`[data-testid="${id}"]`)?.textContent)).toEqual(['28', '2', '3', '27'])
    expect(a.querySelector('[data-testid="cal-split"]')?.textContent).toContain('60 labels (30 pass, 30 fail) of 120')
    expect(a.querySelector('[data-testid="cal-verdict"]')?.textContent).toBe('decisive: passes the bar')
    expect(a.querySelectorAll('[data-testid="cal-trend-row"]')).toHaveLength(2)
    expect(a.querySelector('[data-testid="calibration-contamination"]')).not.toBeNull()
    // The second judge has no version: an empty state with the counts it does have.
    const b = cards[1]!
    expect(b.querySelector('[data-testid="calibration-empty"]')?.textContent).toContain('No calibration yet')
    expect(b.querySelector('[data-testid="cal-to-review"]')?.textContent).toBe('32')
    expect(b.querySelector('[data-testid="cal-label-rows"]')?.textContent).toBe('12')
    expect(b.querySelector('[data-testid="cal-measured"]')).toBeNull()
    expect(a.querySelector('[data-testid="calibration-judge-link"]')?.getAttribute('href')).toBe(`/studio/calibration/${J1}`)
    expect(a.querySelector('[data-testid="calibration-review-link"]')?.getAttribute('href')).toBe(`/studio/review?judge=${J1}`)
    // Read only: no Save, no write control, GET calls only.
    expect(c.textContent).not.toMatch(FORBIDDEN)
    expect(c.querySelectorAll('input, textarea, select, form')).toHaveLength(0)
    expect(calls.every((x) => x.method === 'GET')).toBe(true)
  })

  it('a rate under 0.90 is a side signal only', async () => {
    const weak = detail(J1_V2, { tpr: 0.89, tnr: 0.95, calibration: { nLabels: 120, nTest: 60, tp: 24, fn: 6, tn: 29, fp: 1, realignedAt: null } })
    const c = mountAt('/studio/calibration', { details: [D_V1, weak] })
    await waitFor(() => !!c.querySelector('[data-testid="cal-verdict"]'), 'verdict')
    expect(text(c, 'cal-verdict')).toBe('side signal only')
    expect(c.querySelector('[data-testid="cal-tpr-value"]')?.textContent).toBe('89%')
  })

  it('both rates at the bar but a test split under the floor is still a side signal', async () => {
    const small = detail(J1_V2, { tpr: 1, tnr: 1, calibration: { nLabels: 40, nTest: 20, tp: 10, fn: 0, tn: 10, fp: 0, realignedAt: null } })
    const c = mountAt('/studio/calibration', { details: [D_V1, small] })
    await waitFor(() => !!c.querySelector('[data-testid="cal-verdict"]'), 'verdict')
    expect(text(c, 'cal-verdict')).toBe('side signal only')
    expect(text(c, 'cal-split')).toContain('needs at least 30 pass and 30 fail')
  })

  it('shows an empty card per judge when no judge version exists', async () => {
    const c = mountAt('/studio/calibration', { list: [200, { graderVersions: [OTHER, L1, L2] }] })
    await waitFor(() => c.querySelectorAll('[data-testid="calibration-empty"]').length === 2, 'two empty states')
    expect(c.querySelectorAll('[data-testid="calibration-judge"]')).toHaveLength(2)
    expect(c.querySelector('[data-testid="cal-measured"]')).toBeNull()
    expect(c.textContent).not.toMatch(FORBIDDEN)
  })

  it('shows an empty state when the result store is not migrated (503), and when the queue cannot be read', async () => {
    const a = mountAt('/studio/calibration', { list: [503, { error: 'schema_not_ready' }] })
    await waitFor(() => !!a.querySelector('[data-testid="calibration-unavailable"]'), 'unavailable')
    expect(text(a, 'calibration-unavailable')).toContain('not migrated')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const b = mountAt('/studio/calibration', { queue: [403, { error: 'forbidden' }] })
    await waitFor(() => b.querySelectorAll('[data-testid="calibration-judge"]').length === 2, 'cards without the queue')
    expect(text(b, 'cal-to-review')).toBe('unavailable')
  })

  it('is linked from the studio home, the grader library and the compatibility links', async () => {
    const h = mountAt('/studio')
    await waitFor(() => !!h.querySelector('[data-testid="studio-calibration-link"]'), 'home link')
    expect(h.querySelector('[data-testid="studio-calibration-link"]')?.getAttribute('href')).toBe('/studio/calibration')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const g = mountAt('/studio/graders')
    await waitFor(() => !!g.querySelector('[data-testid="graders-calibration-link"]'), 'library link')
    expect(g.querySelector('[data-testid="graders-calibration-link"]')?.getAttribute('href')).toBe('/studio/calibration')
  })
})

describe('S11a /studio/calibration/:judgeId', () => {
  it('shows the newest version: allowed model, digests, the 90 % bar, a copy command and no Save', async () => {
    const c = mountAt(`/studio/calibration/${J1}`)
    await waitFor(() => !!c.querySelector('[data-testid="judge-definition"]'), 'definition')
    await waitFor(() => !!c.querySelector('[data-testid="cal-measured"]'), 'measured')
    expect(text(c, 'judge-model')).toBe('anthropic/claude-sonnet-5.5')
    expect(text(c, 'judge-rubric')).toBe(SHA.slice(0, 12))
    expect(text(c, 'judge-params')).toBe(SHA.split('').reverse().join('').slice(0, 12))
    expect(text(c, 'judge-bar-text')).toContain('at least 90%')
    expect(text(c, 'cal-tpr-bar-text')).toBe('bar 90%')
    expect(text(c, 'cal-tpr-value')).toBe('93.3%')
    expect(c.querySelector('[data-testid="judge-trend"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="judge-command"]')?.getAttribute('data-copy-command')).not.toBeNull()
    expect(text(c, 'copy-command-text')).toBe(`tma eval judge calibrate --judge ${J1} --version 0.2.0 --model anthropic/claude-sonnet-5.5`)
    expect(c.textContent).not.toMatch(FORBIDDEN)
    for (const el of c.querySelectorAll('button, a')) expect(el.textContent).not.toMatch(FORBIDDEN)
    expect(c.querySelectorAll('input, textarea, select, form')).toHaveLength(0)
    expect(calls.every((x) => x.method === 'GET')).toBe(true)
  })

  it('?version= picks that version', async () => {
    const c = mountAt(`/studio/calibration/${J1}?version=0.1.0`)
    await waitFor(() => !!c.querySelector('[data-testid="cal-version"]'), 'version')
    expect(text(c, 'cal-version')).toBe(`${J1}@0.1.0`)
    expect(text(c, 'cal-tpr-value')).toBe('80%')
  })

  it('never prints a model outside the allowed list', async () => {
    const bad = item('v-9', J2, '0.1.0', 'judge', '2026-11-14T10:00:00.000Z', 0, 'openai/gpt-5-mini')
    const c = mountAt(`/studio/calibration/${J2}`, { list: [200, { graderVersions: [bad] }], details: [detail(bad)] })
    await waitFor(() => !!c.querySelector('[data-testid="judge-model"]'), 'model')
    expect(text(c, 'judge-model')).toBe('a model outside the allowed list')
    expect(c.textContent).not.toContain('gpt-5-mini')
    expect(text(c, 'copy-command-text')).toContain('--model <model id>')
    expect(text(c, 'cal-verdict')).toBe('not measured')
  })

  it('a judge with no version shows the bar and an empty state', async () => {
    const c = mountAt(`/studio/calibration/${J2}`, { list: [200, { graderVersions: [OTHER] }] })
    await waitFor(() => !!c.querySelector('[data-testid="judge-empty"]'), 'empty')
    expect(text(c, 'judge-bar-text')).toContain('90%')
    expect(text(c, 'cal-tpr-value')).toBe('n/a')
    expect(text(c, 'copy-command-text')).toContain('--version <semver>')
    expect(c.textContent).not.toMatch(FORBIDDEN)
  })

  it('an unknown judge id is an empty state, not a crash, and loads no calibration data', async () => {
    const c = mountAt('/studio/calibration/not-a-judge')
    await waitFor(() => !!c.querySelector('[data-testid="judge-unknown"]'), 'unknown')
    expect(calls.filter((x) => x.path.startsWith('/grader-versions') || x.path.startsWith('/review-queue'))).toHaveLength(0)
  })

  it('the grader detail of a judge version links to S11a with the version', async () => {
    const c = mountAt('/studio/graders/v-2')
    await waitFor(() => !!c.querySelector('[data-testid="grader-calibration-link"]'), 'link')
    expect(c.querySelector('[data-testid="grader-calibration-link"]')?.getAttribute('href')).toBe(`/studio/calibration/${J1}?version=0.2.0`)
  })
})
