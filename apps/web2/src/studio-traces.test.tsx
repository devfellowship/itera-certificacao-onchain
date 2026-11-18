// @vitest-environment jsdom
/**
 * S2 trace picker and S3 trace view (plan 20261112-tma-c5-studio-area-web2, task C5-T6).
 * Mounted through routes.tsx (layout, nav, session gate) with a saved session and a stubbed fetch that answers both
 * the TMA API (API_URL) and `tma studio serve` (the serve base URL, mocked into config). Fixture text is synthetic.
 * Proves: rows, task summary, signal chips, pin states, S3 links, filters and paging in the request query, the
 * error states (401, 403, network, not configured, 404), the S3 summary / first failure / step markers, and the
 * network rule of parent ADR-1: every trace read goes to the serve with GET + bearer, and no fixture trace text and
 * no session id ever goes to the TMA API.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const serveState = vi.hoisted(() => ({ url: 'http://127.0.0.1:8799' }))
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
import { API_URL } from './config'
import { routes } from './routes'
import { orderRuns } from './studio/StudioTracePage'
import { TraceServeError, fetchTrace, fetchTraceList, traceErrorText, type Trace, type TraceList, type TraceRow } from './studio/traces'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SERVE = 'http://127.0.0.1:8799'
const TOKEN = 'web2-session-token-fixture'
const SID_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SID_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const SID_C = 'cccccccc-0000-4000-8000-00000000000c'
const SUB = 'a0fixture0sub'

/** Every piece of trace content in the fixtures. None may reach the TMA API. */
const TRACE_TEXT = [
  'fixture-before-text',
  'fixture-expected-text',
  'fixture-outcome-text',
  'fixture-preview-step-0',
  'fixture-preview-step-1',
  'fixture-preview-failed-step',
  'fixture-session-title',
  SID_A,
  SID_B,
  SID_C,
]

const row = (over: Partial<TraceRow>): TraceRow => ({
  session_id: SID_A,
  agent_id: null,
  parent_session_id: null,
  run_kind: 'main',
  identifier: 'DFL-00001',
  task_id: '11111111-0000-4000-8000-000000000001',
  executor: 'fixture-executor',
  harness: 'claude-code',
  host: 'fixture-host',
  model: 'fixture-model',
  l2_class: 'build',
  mode: 'trace_review',
  why: 'red',
  red: true,
  replayable: true,
  pr: null,
  n_delivering_prs: 0,
  started_at: '2026-11-01T10:00:00.000Z',
  signals: { revert: false, ci_rerun: true, correction: null },
  task_summary: null,
  pin: null,
  has_trajectory: true,
  ...over,
})

const LIST: TraceList = {
  source: { selection_day: '2026-11-02', pins: true },
  total: 120,
  offset: 0,
  limit: 50,
  rows: [
    row({
      task_summary: { before: 'fixture-before-text', expected: 'fixture-expected-text', outcome: 'fixture-outcome-text' },
      pin: { pin_sha256: 'f'.repeat(64), complete: false, missing: ['repo', 'base_sha'], layer1: true },
      pr: { url: 'https://github.com/example/repo/pull/7', number: 7 },
    }),
    row({ agent_id: SUB, run_kind: 'subagent', l2_class: 'fix', why: 'sample', task_summary: { before: null, expected: 'fixture-expected-text', outcome: null }, pin: { pin_sha256: 'e'.repeat(64), complete: true, missing: [], layer1: true }, pr: { url: 'javascript:alert(1)' }, signals: { revert: true, ci_rerun: true } }),
    row({ session_id: SID_B, identifier: null, task_id: null, l2_class: 'plan', mode: 'replay', has_trajectory: false, pr: 'https://github.com/x/y/pull/1' }),
    row({ session_id: SID_C, identifier: null, task_id: 'task-only-id', signals: null }),
  ],
}

const span = (seq: number, ok: boolean, ts: string, preview: string) => ({
  seq, turn_seq: 1, ts, ts_end: ts, dur_ms: 10, tool: 'Bash', shape: 'npm', intent: 'test-run', family: 'shell', target_kind: 'file', target: null, ok, retry_of: null, child_run: null, preview, bytes_out: 5,
})
const TRACE: Trace = {
  session_id: SID_A,
  agent_id: null,
  index: { host: 'fixture-host', harness: 'claude-code', kind: 'main', first_ts: '2026-11-01T10:00:00Z', last_ts: '2026-11-01T10:05:00Z', message_count: 12, models: ['fixture-model'], state: 'live' },
  candidate: LIST.rows[0]!,
  pin: LIST.rows[0]!.pin,
  task_summary: LIST.rows[0]!.task_summary,
  summary: {
    title: 'fixture-session-title', started_at: '2026-11-01T10:00:00.000Z', ended_at: '2026-11-01T10:05:00.000Z', duration_s: 300, active_s: 125, channel: null, models: ['fixture-model'],
    n_runs: 2, n_subagent_runs: 1, n_tool_calls: 3, tool_counts: { Bash: 3, Read: 9, a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 }, intent_counts: null, errors: 1, outcome_signals: null,
    closure_confidence: 'high', cost_usd: 1.234, extractor_version: 'x',
  },
  runs: [
    // Out of order on purpose: S3 shows the main run first.
    { agent_id: SUB, parent_agent_id: null, is_subagent: true, spawn_depth: 1, agent_type: 'general-purpose', description: 'fixture subagent', title: null, started_at: '2026-11-01T10:00:02.000Z', ended_at: null, duration_s: 5, models: [], n_tool_calls: 1, errors: 1, spans: [span(0, false, '2026-11-01T10:00:03.000Z', 'fixture-preview-failed-step\nline 2\nline 3\nline 4\nline 5')] },
    { agent_id: null, parent_agent_id: null, is_subagent: false, spawn_depth: 0, agent_type: null, description: null, title: null, started_at: '2026-11-01T10:00:00.000Z', ended_at: null, duration_s: 300, models: ['fixture-model'], n_tool_calls: 2, errors: 0, spans: [span(0, true, '2026-11-01T10:00:01.000Z', 'fixture-preview-step-0'), span(1, true, '2026-11-01T10:00:09.000Z', 'fixture-preview-step-1')] },
  ],
  first_failure: { agent_id: SUB, ...span(0, false, '2026-11-01T10:00:03.000Z', 'fixture-preview-failed-step\nline 2\nline 3\nline 4\nline 5') },
}

type Call = { url: string; method: string; headers: Record<string, string>; body: string; credentials?: string; cache?: string }
const calls: Call[] = []
type Answer = [number, unknown] | 'network'

let root: Root | undefined
beforeEach(() => {
  serveState.url = SERVE
})
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

function mountAt(path: string, answers: { list?: Answer; trace?: Answer } = {}, keepCalls = false) {
  saveSession({ token: TOKEN, user: { id: 'u-1', email: 'ana@example.com' } })
  if (!keepCalls) calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const h = new Headers(init.headers)
      const headers: Record<string, string> = {}
      h.forEach((v, k) => (headers[k] = v))
      calls.push({ url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '', credentials: init.credentials, cache: init.cache })
      const u = new URL(url)
      if (url.startsWith(`${SERVE}/`)) {
        const a = u.pathname === '/v1/traces' ? (answers.list ?? [200, LIST]) : (answers.trace ?? [200, TRACE])
        if (a === 'network') throw new TypeError('Failed to fetch')
        return json(...a)
      }
      if (u.pathname === '/me') return json(200, { wallet: 'u-1', username: null, displayName: 'Ana', handle: null, avatarUrl: null, initials: 'AN' })
      return json(404, { error: 'not found' })
    }),
  )
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />))
  return c
}
const traceRows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-trace-row]')]
const serveCalls = () => calls.filter((x) => x.url.startsWith(`${SERVE}/`))
const apiCalls = () => calls.filter((x) => x.url.startsWith(`${API_URL}/`) || x.url === API_URL)

/** Follow a link the way a user does, by its href (a click on a data-router Link aborts in jsdom). */
function follow(a: HTMLAnchorElement, answers: { list?: Answer; trace?: Answer } = {}, keepCalls = false) {
  const href = a.getAttribute('href')!
  act(() => root?.unmount())
  document.body.innerHTML = ''
  return mountAt(href, answers, keepCalls)
}

/** The network rule (parent ADR-1). Returns the TMA API paths seen. */
function assertNetworkRule(): string[] {
  expect(serveCalls().length).toBeGreaterThan(0)
  for (const x of serveCalls()) {
    expect(x.method).toBe('GET')
    expect(x.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(Object.keys(x.headers)).toEqual(['authorization'])
    expect(x.credentials).toBe('omit')
    expect(x.cache).toBe('no-store')
    expect(x.body).toBe('')
  }
  // Every request goes either to the serve or to the TMA API; nothing else.
  expect(calls.every((x) => x.url.startsWith(`${SERVE}/`) || x.url.startsWith(`${API_URL}/`))).toBe(true)
  for (const x of apiCalls()) for (const t of TRACE_TEXT) {
    expect(x.url, `API url carries ${t}`).not.toContain(t)
    expect(x.body, `API body carries ${t}`).not.toContain(t)
  }
  return apiCalls().map((x) => `${x.method} ${new URL(x.url).pathname}`)
}

describe('S2 trace picker', () => {
  it('renders one row per candidate with its task summary, chips, pin and S3 link', async () => {
    const c = mountAt('/studio/traces')
    await waitFor(() => traceRows(c).length > 0, 'rows')
    const r = traceRows(c)
    expect(r).toHaveLength(LIST.rows.length)
    expect(c.querySelector('h1')!.textContent).toBe('Traces')
    expect(c.textContent).toContain('not from the TMA server')
    // The focus panel starts on the first row: task summary Before / Expected / Outcome, labelled.
    const focus = () => c.querySelector<HTMLElement>('[data-testid="trace-focus"]')!
    expect(r[0]!.getAttribute('data-focused')).toBe('true')
    const ts = focus().querySelector('[data-task-summary]')!
    expect([...ts.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Before', 'Expected', 'Outcome'])
    expect(ts.querySelector('[data-field="before"]')!.textContent).toBe('fixture-before-text')
    expect(ts.querySelector('[data-field="expected"]')!.textContent).toBe('fixture-expected-text')
    expect(ts.querySelector('[data-field="outcome"]')!.textContent).toBe('fixture-outcome-text')
    // MT-04: the row shows the task id only: no Before line under it, no "picked for" tag.
    expect(r[0]!.textContent).not.toContain('fixture-before-text')
    expect(c.querySelector('.trc-task-before')).toBeNull()
    expect(c.querySelector('[data-trace-row] [data-why]')).toBeNull()
    expect(focus().querySelector('[data-field="why"]')!.textContent).toBe('red')
    // Pin states, in the panel of the focused row (a click focuses a row; a null field shows a dash).
    expect(focus().querySelector('[data-pin]')!.getAttribute('data-pin')).toBe('incomplete')
    expect(focus().querySelector('[data-pin]')!.textContent).toBe('pinned incomplete (2 missing)')
    expect(focus().textContent).toContain('fixture-executor / claude-code / fixture-host')
    act(() => r[1]!.click())
    expect(r[1]!.getAttribute('data-focused')).toBe('true')
    expect(r[0]!.getAttribute('data-focused')).toBeNull()
    const ts2 = focus().querySelector('[data-task-summary]')!
    expect(ts2.querySelector('[data-field="before"]')!.textContent).toBe('—')
    expect(ts2.querySelector('[data-field="outcome"]')!.textContent).toBe('—')
    expect(focus().querySelector('[data-pin]')!.textContent).toBe('pinned complete')
    act(() => r[2]!.click())
    expect(focus().querySelector('[data-task-summary]')).toBeNull()
    expect(focus().textContent).toContain('No task summary.')
    expect(focus().querySelector('[data-pin]')!.textContent).toBe('not pinned')
    expect(focus().querySelector('[data-testid="trace-open"]')).toBeNull()
    // Signals: only the true ones, as words.
    expect([...r[0]!.querySelectorAll('[data-signal]')].map((x) => x.getAttribute('data-signal'))).toEqual(['ci_rerun'])
    expect([...r[1]!.querySelectorAll('[data-signal]')].map((x) => x.getAttribute('data-signal'))).toEqual(['revert', 'ci_rerun'])
    expect(r[3]!.querySelectorAll('[data-signal]')).toHaveLength(0)
    expect(r[3]!.textContent).toContain('none')
    // The replayable column follows the pin.
    expect(r.map((x) => x.querySelector('[data-replay]')!.getAttribute('data-replay'))).toEqual(['partly', 'yes', 'unpinned', 'unpinned'])
    // Labels.
    expect(r[0]!.textContent).toContain('DFL-00001')
    // MT-19: harness on line 1, the model on its own muted line.
    expect(r[0]!.querySelector('.trc-agent__name')!.textContent).toBe('Claude Code')
    expect(r[0]!.querySelector('[data-field="model-line"]')!.textContent).toBe('fixture-model')
    expect(r[0]!.textContent).toContain('2026-11-01')
    expect(r[2]!.textContent).toContain(SID_B.slice(0, 8))
    expect(r[3]!.textContent).toContain('task-only-id')
    // PR link only for an object with a github.com https URL.
    expect(r[0]!.querySelector('[data-testid="trace-pr"]')!.getAttribute('href')).toBe('https://github.com/example/repo/pull/7')
    expect(r[1]!.querySelector('[data-testid="trace-pr"]')).toBeNull()
    expect(r[2]!.querySelector('[data-testid="trace-pr"]')).toBeNull()
    // S3 links: agent_id when set; no link without a trajectory file.
    expect(r[0]!.querySelector('[data-testid="trace-link"]')!.getAttribute('href')).toBe(`/studio/traces/${SID_A}`)
    expect(r[1]!.querySelector('[data-testid="trace-link"]')!.getAttribute('href')).toBe(`/studio/traces/${SID_A}?agent_id=${SUB}`)
    expect(r[2]!.querySelector('[data-testid="trace-link"]')).toBeNull()
    expect(r[2]!.querySelector('[data-testid="trace-no-file"]')!.textContent).toBe('no trajectory file')
    // MT-04: no source line in the page; the selection day and pins live in the (i) of the title.
    expect(c.querySelector('[data-testid="trace-source"]')).toBeNull()
    expect(c.textContent).not.toContain('Selection day 2026-11-02. Pins exist')
    expect(c.querySelector('.trc-head .stu-label a')).toBeNull()
    expect(c.querySelector('.trc-title')!.textContent).toContain('Selection day 2026-11-02; pins exist for this day. Newest first on each page.')
    // Traces is the active Studio item in the nav (MT-03).
    expect([...c.querySelectorAll('nav a[aria-current="page"]')].map((a) => a.textContent)).toEqual(['Traces'])
    // No HTML injection path.
    expect(c.innerHTML).not.toContain('javascript:')
  })

  it('asks the serve with the default page and filters, and the filter links change the query', async () => {
    const c = mountAt('/studio/traces')
    await waitFor(() => traceRows(c).length > 0, 'rows')
    expect(serveCalls().map((x) => x.url)).toEqual([`${SERVE}/v1/traces?limit=50`])
    // MT-02: one Filters button; the groups are in its dropdown, closed at first; no chip, no count, no Clear all.
    const btn = c.querySelector<HTMLButtonElement>('[data-testid="trace-filters-button"]')!
    expect(btn.textContent).toBe('Filters')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(c.querySelector('[data-filter]')).toBeNull()
    expect(c.querySelector('[data-chip]')).toBeNull()
    expect(c.querySelector('[data-testid="trace-clear"]')).toBeNull()
    act(() => btn.click())
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const l2 = c.querySelector('[data-testid="trace-filters-panel"] [data-filter="l2_class"]')!
    expect([...l2.querySelectorAll('[data-filter-value]')].map((a) => a.getAttribute('data-filter-value'))).toEqual(['all', 'build', 'fix', 'plan'])
    const fix = l2.querySelector<HTMLAnchorElement>('[data-filter-value="fix"]')!
    expect(fix.getAttribute('href')).toBe('/studio/traces?l2_class=fix')
    const f = follow(fix)
    await waitFor(() => serveCalls().length > 0 && traceRows(f).length > 0, 'filtered')
    expect(serveCalls().map((x) => x.url)).toEqual([`${SERVE}/v1/traces?limit=50&l2_class=fix`])
    // The active filter is a removable chip; the button counts it; Clear all and the chip's x drop it from the URL.
    expect(f.querySelector('[data-testid="trace-filters-count"]')!.textContent).toBe('1')
    const chip = f.querySelector('[data-chip="l2_class"]')!
    expect(chip.textContent).toBe('Use case: fix')
    expect(chip.querySelector('[data-testid="trace-chip-remove"]')!.getAttribute('href')).toBe('/studio/traces')
    expect(chip.querySelector('[data-testid="trace-chip-remove"]')!.getAttribute('aria-label')).toBe('Remove filter Use case')
    expect(f.querySelector('[data-testid="trace-clear"]')!.getAttribute('href')).toBe('/studio/traces')
    expect(f.querySelector('[data-testid="trace-filters-more"]')).toBeNull()
    act(() => f.querySelector<HTMLButtonElement>('[data-testid="trace-filters-button"]')!.click())
    expect(f.querySelector('[data-filter="l2_class"] [aria-current="true"]')!.textContent).toBe('fix')
    // Escape closes the dropdown.
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(f.querySelector('[data-testid="trace-filters-panel"]')).toBeNull()
  })

  it('shows one chip per active filter, keeps the other filters when one chip is removed', async () => {
    const c = mountAt('/studio/traces?l2_class=fix&why=red&mode=trace_review&offset=50')
    await waitFor(() => traceRows(c).length > 0, 'rows')
    expect(c.querySelector('[data-testid="trace-filters-count"]')!.textContent).toBe('3')
    expect([...c.querySelectorAll('[data-chip]')].map((x) => x.textContent)).toEqual(['Use case: fix', 'Picked for: red', 'Mode: trace review'])
    const hrefs = [...c.querySelectorAll('[data-testid="trace-chip-remove"]')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['/studio/traces?why=red&mode=trace_review', '/studio/traces?l2_class=fix&mode=trace_review', '/studio/traces?l2_class=fix&why=red'])
  })

  it('reads in plain words: filter labels, no underscore in a value, one signal label map, who line and date order', async () => {
    const list = {
      ...LIST,
      rows: [
        row({ started_at: '2026-11-01T10:00:00.000Z', signals: { ci_rerun: true, red_ci: true }, model: 'opus-medium' }),
        row({ session_id: SID_B, identifier: 'DFL-00002', started_at: '2026-11-10T09:00:00.000Z', signals: { abandoned: true, revert: true }, mode: 'trace_review' }),
        row({ session_id: SID_C, identifier: 'DFL-00003', started_at: '2026-11-03T09:00:00.000Z', signals: { something_new: true } }),
      ],
    }
    const c = mountAt('/studio/traces?mode=trace_review', { list: [200, list] })
    await waitFor(() => traceRows(c).length > 0, 'rows')
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="trace-filters-button"]')!.click())
    // Filter group labels are words; the URL parameters keep the field keys.
    expect([...c.querySelectorAll('[data-filter]')].map((f) => [f.getAttribute('data-filter'), f.querySelector('.stu-label')!.textContent])).toEqual([
      ['l2_class', 'Use case'],
      ['why', 'Picked for'],
      ['mode', 'Mode'],
      ['small_diff', 'Small diff'],
    ])
    const mode = c.querySelector('[data-filter="mode"] [data-filter-value="trace_review"]')!
    expect(mode.textContent).toBe('trace review')
    expect(mode.getAttribute('href')).toBe('/studio/traces?mode=trace_review')
    // Newest first on each page.
    expect(traceRows(c).map((r) => r.dataset.sessionId)).toEqual([SID_B, SID_C, SID_A])
    // One label map for the chips and the panel line; an unknown key reads with a space.
    const sig = (r: HTMLElement) => [...r.querySelectorAll('[data-signal]')].map((x) => x.textContent)
    expect(sig(traceRows(c)[0]!)).toEqual(['abandoned,', 'revert'])
    expect(sig(traceRows(c)[1]!)).toEqual(['something new'])
    expect(sig(traceRows(c)[2]!)).toEqual(['re-run,', 'red CI'])
    expect(c.textContent).not.toMatch(/ci_rerun|red_ci/)
    const panel = c.querySelector<HTMLElement>('[data-testid="trace-focus"]')!
    expect(panel.textContent).toContain('Signal: abandoned, revert')
    // The who line is one short date on one line.
    expect(panel.querySelector('[data-field="who-line"]')!.textContent).toBe('Claude Code · fixture-model · 10 Nov')
    // The why chip is neutral for every value, including "red".
    expect(c.querySelector('.trc-why--red')).toBeNull()
  })

  it('MT-12/13: the task name labels the row, with fallbacks; the panel shows External ID and an https External URL', async () => {
    const url = 'https://os.devfellowship.com/tasks/11111111-0000-4000-8000-000000000001'
    const list = {
      ...LIST,
      rows: [
        row({ started_at: '2026-11-10T10:00:00.000Z', task_name: 'Fix the login redirect', external_id: 'DFL-00001', external_url: url }),
        row({ session_id: SID_B, identifier: 'DFL-00002', started_at: '2026-11-09T10:00:00.000Z', task_name: '  ', external_url: 'javascript:alert(1)' }),
        row({ session_id: SID_C, identifier: null, task_id: null, started_at: '2026-11-08T10:00:00.000Z' }),
      ],
    }
    const c = mountAt('/studio/traces', { list: [200, list] })
    await waitFor(() => traceRows(c).length === 3, 'rows')
    const label = (r: HTMLElement) => r.querySelector('.trc-task-id')!.textContent
    expect(traceRows(c).map(label)).toEqual(['Fix the login redirect', 'DFL-00002', `Session ${SID_C.slice(0, 8)}`])
    // The focused row (the first) shows its DFL id and a link to the task where it lives.
    const ext = () => c.querySelector('[data-testid="trace-focus"] [data-testid="trace-external"]')
    expect(ext()!.querySelector('[data-field="external_id"]')!.textContent).toBe('DFL-00001')
    const a = ext()!.querySelector<HTMLAnchorElement>('[data-testid="trace-external-url"]')!
    expect(a.getAttribute('href')).toBe(url)
    expect(a.getAttribute('rel')).toBe('noreferrer')
    expect([...ext()!.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['External ID', 'External URL'])
    // A URL that is not https is never a link; the id falls back to the DFL identifier.
    act(() => traceRows(c)[1]!.click())
    expect(ext()!.querySelector('[data-field="external_id"]')!.textContent).toBe('DFL-00002')
    expect(ext()!.querySelector('a')).toBeNull()
    expect(c.innerHTML).not.toContain('javascript:')
    // No id and no URL: no block at all.
    act(() => traceRows(c)[2]!.click())
    expect(ext()).toBeNull()
  })

  it('MT-11: the Small diff filter sends small_diff to the serve, shows a chip, and the panel shows the file count', async () => {
    const list = {
      ...LIST,
      rows: [
        row({ started_at: '2026-11-10T10:00:00.000Z', small_diff: true, pr: { url: 'https://github.com/o/r/pull/32', files_changed: 2, additions: 8, deletions: 10 } }),
        row({ session_id: SID_B, identifier: 'DFL-00002', started_at: '2026-11-09T10:00:00.000Z', small_diff: false, pr: { url: 'https://github.com/o/r/pull/33', files_changed: 7 } }),
        row({ session_id: SID_C, identifier: 'DFL-00003', started_at: '2026-11-08T10:00:00.000Z' }),
      ],
    }
    const c = mountAt('/studio/traces?small_diff=true', { list: [200, list] })
    await waitFor(() => traceRows(c).length === 3, 'rows')
    expect(new URL(serveCalls()[0]!.url).searchParams.get('small_diff')).toBe('true')
    expect([...c.querySelectorAll('[data-chip]')].map((x) => x.textContent)).toEqual(['Small diff: yes'])
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="trace-filters-button"]')!.click())
    const opts = [...c.querySelectorAll<HTMLAnchorElement>('[data-filter="small_diff"] [data-filter-value]')]
    expect(opts.map((o) => [o.dataset.filterValue, o.getAttribute('aria-current')])).toEqual([
      ['all', null],
      ['true', 'true'],
      ['false', null],
    ])
    expect(opts[2]!.getAttribute('href')).toBe('/studio/traces?small_diff=false')
    expect(c.querySelector('[data-testid="trace-clear"]')!.getAttribute('href')).toBe('/studio/traces')
    // The file-count hint: small, not small, and no data.
    const hint = () => c.querySelector('[data-testid="trace-focus"] [data-testid="trace-diff-hint"]')
    expect(hint()!.textContent).toBe('Small diff: 2 files changed')
    expect(hint()!.getAttribute('data-small-diff')).toBe('true')
    expect(c.querySelector('[data-testid="trace-focus"] [data-field="files_changed"]')!.textContent).toBe('2')
    act(() => traceRows(c)[1]!.click())
    expect(hint()!.textContent).toBe('7 files changed')
    expect(hint()!.getAttribute('data-small-diff')).toBe('false')
    act(() => traceRows(c)[2]!.click())
    expect(hint()).toBeNull()
    expect(c.querySelector('[data-testid="trace-focus"] [data-field="files_changed"]')!.textContent).toBe('—')
  })

  it('MT-11: an unknown small_diff value is not sent to the serve', async () => {
    const c = mountAt('/studio/traces?small_diff=maybe')
    await waitFor(() => traceRows(c).length > 0, 'rows')
    expect(new URL(serveCalls()[0]!.url).searchParams.has('small_diff')).toBe(false)
  })

  it('selects rows with the checkbox column: "N selected", select all on the page, Clear, a disabled Build button (MT-05)', async () => {
    const c = mountAt('/studio/traces')
    await waitFor(() => traceRows(c).length > 0, 'rows')
    expect(c.querySelector('[data-testid="trace-selection"]')).toBeNull()
    const boxes = () => traceRows(c).map((r) => r.querySelector<HTMLInputElement>('[data-testid="trace-select"]')!)
    const focusedBefore = traceRows(c)[0]!.getAttribute('data-focused')
    act(() => boxes()[1]!.click())
    act(() => boxes()[2]!.click())
    expect(boxes().map((b) => b.checked)).toEqual([false, true, true, false])
    expect(c.querySelector('[data-testid="trace-selection-count"]')!.textContent).toBe('2 selected')
    // A checkbox click (and the focus it takes) does not move the focused row.
    act(() => boxes()[2]!.focus())
    expect(traceRows(c)[0]!.getAttribute('data-focused')).toBe(focusedBefore)
    expect(traceRows(c)[2]!.getAttribute('data-focused')).toBeNull()
    // The build button names the count and stays disabled until its write path lands (MT-05, Q 3d291a2b = A).
    const build = c.querySelector<HTMLButtonElement>('[data-testid="trace-build-cases"]')!
    expect(build.textContent).toBe('Build 2 cases')
    expect(build.disabled).toBe(true)
    const all = c.querySelector<HTMLInputElement>('[data-testid="trace-select-all"]')!
    act(() => all.click())
    expect(c.querySelector('[data-testid="trace-selection-count"]')!.textContent).toBe(`${LIST.rows.length} selected`)
    expect(all.checked).toBe(true)
    act(() => all.click())
    expect(c.querySelector('[data-testid="trace-selection"]')).toBeNull()
    act(() => boxes()[0]!.click())
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="trace-selection-clear"]')!.click())
    expect(c.querySelector('[data-testid="trace-selection"]')).toBeNull()
    expect(boxes().every((b) => !b.checked)).toBe(true)
  })

  it('passes why, mode and offset from the URL', async () => {
    const c = mountAt('/studio/traces?why=red&mode=replay&offset=50')
    await waitFor(() => traceRows(c).length > 0, 'rows')
    expect(serveCalls().map((x) => x.url)).toEqual([`${SERVE}/v1/traces?limit=50&offset=50&why=red&mode=replay`])
  })

  it('pages with Prev and Next and shows n of total', async () => {
    const c = mountAt('/studio/traces?offset=50&l2_class=build', { list: [200, { ...LIST, offset: 50 }] })
    await waitFor(() => traceRows(c).length > 0, 'rows')
    expect(c.querySelector('[data-testid="trace-count"]')!.textContent).toBe('51–54 of 120')
    expect(c.querySelector('[data-testid="trace-prev"]')!.getAttribute('href')).toBe('/studio/traces?l2_class=build')
    const next = c.querySelector<HTMLAnchorElement>('[data-testid="trace-next"]')!
    expect(next.getAttribute('href')).toBe('/studio/traces?offset=100&l2_class=build')
    follow(next)
    await waitFor(() => serveCalls().length > 0, 'next page')
    expect(serveCalls()[0]!.url).toBe(`${SERVE}/v1/traces?limit=50&offset=100&l2_class=build`)
  })

  it('first page: no Prev; last page: no Next', async () => {
    const c = mountAt('/studio/traces', { list: [200, { ...LIST, total: 4 }] })
    await waitFor(() => traceRows(c).length > 0, 'rows')
    expect(c.querySelector('[data-testid="trace-prev"]')).toBeNull()
    expect(c.querySelector('[data-testid="trace-next"]')).toBeNull()
    expect(c.querySelector('[data-testid="trace-count"]')!.textContent).toBe('1–4 of 4')
  })

  it('shows the empty state', async () => {
    const c = mountAt('/studio/traces?why=red', { list: [200, { ...LIST, total: 0, rows: [] }] })
    await waitFor(() => !!c.querySelector('[data-testid="traces-empty"]'), 'empty')
    expect(c.querySelector('[data-testid="traces-empty"]')!.textContent).toBe('No candidate traces match these filters.')
  })

  it.each([
    [[401, { error: 'expired_token' }] as Answer, 'Your session ended. Sign in again.'],
    [[403, { error: 'principal_not_allowed' }] as Answer, 'Your account may not read fleet traces.'],
    [[404, { error: 'no_trace_selection' }] as Answer, 'No trace selection exists yet.'],
    ['network' as Answer, 'The trace service did not answer. It is reachable only on the private network (tailnet): open this page from a device on the tailnet.'],
    [[500, { error: 'read_failed' }] as Answer, 'The trace service could not load this data. Reload the page to try again.'],
  ])('shows the error state %#', async (answer, text) => {
    const c = mountAt('/studio/traces', { list: answer })
    await waitFor(() => !!c.querySelector('[data-testid="trace-error"]'), 'error')
    expect(c.querySelector('[data-testid="trace-error"]')!.textContent).toBe(text)
    expect(c.textContent).not.toContain(TOKEN)
    // A 401 from the serve does not sign the user out of the TMA session.
    expect(localStorage.getItem('tma2.session')).toContain(TOKEN)
  })

  it('shows not configured when the serve URL is empty, and makes no trace request', async () => {
    serveState.url = ''
    const c = mountAt('/studio/traces')
    await waitFor(() => !!c.querySelector('[data-testid="trace-error"]'), 'not configured')
    expect(c.querySelector('[data-testid="trace-error"]')!.textContent).toBe('The trace service is not configured on this build.')
    expect(serveCalls()).toHaveLength(0)
  })
})

describe('S3 trace view', () => {
  it('shows the summary, the task summary with Outcome, the first failure and the steps', async () => {
    const c = mountAt(`/studio/traces/${SID_A}`)
    await waitFor(() => !!c.querySelector('[data-trace-summary]'), 'summary')
    expect(serveCalls().map((x) => x.url)).toEqual([`${SERVE}/v1/traces/${SID_A}`])
    const s = c.querySelector('[data-trace-summary]')!
    expect(s.textContent).toContain('fixture-session-title')
    expect(s.querySelector('h1')!.textContent).toBe('fixture-session-title')
    expect(s.querySelector('[data-field="wall"]')!.textContent).toBe('5m 0s')
    expect(s.querySelector('[data-field="active"]')!.textContent).toBe('2m 5s')
    expect(s.querySelector('[data-field="runs"]')!.textContent).toBe('2 · 1 subagent')
    expect(s.querySelector('[data-field="tool_calls"]')!.textContent).toBe('3')
    expect(s.querySelector('[data-field="errors"]')!.textContent).toBe('1')
    expect(s.querySelector('[data-field="cost"]')!.textContent).toBe('$1.23')
    // The Summary tab: session, top 8 tools by count, index, task summary with Outcome, candidate info.
    expect(c.querySelector('[data-testid="trace-summary-tab"]')).toBeNull()
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="trace-tab-summary"]')!.click())
    const tab = c.querySelector('[data-testid="trace-summary-tab"]')!
    expect(tab.textContent).toContain('2026-11-01 10:00:00')
    expect(tab.textContent).toContain('5m 0s')
    const tools = tab.querySelector('[data-field="tool_counts"]')!.textContent!
    expect(tools.startsWith('Read 9 · Bash 3')).toBe(true)
    expect(tools.split(' · ')).toHaveLength(8)
    expect(c.querySelector('[data-testid="trace-index"]')!.textContent).toContain('fixture-host')
    const ts = c.querySelector('[data-testid="trace-candidate"] [data-task-summary]')!
    expect(ts.querySelector('[data-field="outcome"]')!.textContent).toBe('fixture-outcome-text')
    expect(c.querySelector('[data-testid="trace-candidate"] [data-pin]')!.textContent).toBe('pinned incomplete (2 missing)')
    expect(c.querySelector('[data-testid="trace-candidate"] [data-why]')!.textContent).toBe('red')
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="trace-tab-calls"]')!.click())
    // MT-16: the side panel shows the selected step; at first that is the first failure, marked as such.
    const ff = c.querySelector('[data-testid="trace-step-panel"]')!
    expect(ff.hasAttribute('data-first-failure')).toBe(true)
    expect(ff.textContent).toContain('Where it went wrong')
    expect(c.querySelector('[data-testid="trace-first-failure-link"]')).toBeNull()
    // Technical details are open and follow the selected step; with two runs they name the step's run.
    const tech = () => c.querySelector('[data-testid="trace-technical"]')!
    expect(tech().closest('details')!.open).toBe(true)
    expect(tech().textContent).toContain(SUB)
    expect(ff.textContent).toContain('test-run')
    expect(ff.textContent).toContain('fixture-preview-failed-step')
    // MT-15: a failed step's payload is red.
    expect(ff.querySelector('[data-testid="step-preview"]')!.getAttribute('data-tone')).toBe('bad')
    // MT-17: the run constants sit once under the title, not in the step details.
    const constants = c.querySelector('[data-testid="trace-constants"]')!
    expect([...constants.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Agent', 'Harness', 'Host', 'Extractor', 'Pin'])
    expect(constants.querySelector('[data-constant="host"] dd')!.textContent).toBe('fixture-host')
    expect([...tech().querySelectorAll('dt')].map((d) => d.textContent)).not.toContain('Harness')
    // Steps: main run first, ok/failed markers, one first-failure step.
    const runs = [...c.querySelectorAll<HTMLElement>('[data-testid="trace-run"]')]
    expect(runs.map((r) => r.dataset.agentId)).toEqual(['', SUB])
    const steps = [...c.querySelectorAll<HTMLElement>('[data-trace-step]')]
    expect(steps).toHaveLength(3)
    expect(steps.map((x) => x.dataset.stepOk)).toEqual(['true', 'true', 'false'])
    const marked = c.querySelectorAll('[data-first-failure-step]')
    expect(marked).toHaveLength(1)
    expect(marked[0]).toBe(steps[2])
    expect(c.querySelector('[data-testid="trace-shown"]')!.textContent).toBe('showing 3 of 3 calls')
    // A click on another step replaces the panel: that step only, its details, and a jump link back to the failure.
    act(() => steps[0]!.click())
    const panel = c.querySelector('[data-testid="trace-step-panel"]')!
    expect(c.querySelectorAll('[data-testid="trace-step-panel"]')).toHaveLength(1)
    expect(panel.hasAttribute('data-first-failure')).toBe(false)
    expect(panel.textContent).toContain('Completed')
    expect(panel.textContent).toContain('fixture-preview-step-0')
    expect(panel.textContent).not.toContain('fixture-preview-failed-step')
    expect(panel.querySelector('[data-testid="step-preview"]')!.getAttribute('data-tone')).toBe('ok')
    expect(tech().getAttribute('data-step-id')).toBe(panel.getAttribute('data-step-id'))
    expect(tech().textContent).not.toContain(SUB)
    expect(steps[0]!.getAttribute('data-step-ok')).toBe('true')
    const jump = c.querySelector<HTMLButtonElement>('[data-testid="trace-first-failure-link"]')!
    expect(jump.textContent).toContain('Where it went wrong: step')
    act(() => jump.click())
    expect(c.querySelector('[data-testid="trace-step-panel"]')!.hasAttribute('data-first-failure')).toBe(true)
    expect(tech().textContent).toContain(SUB)
    // Back link to S2.
    expect(c.querySelector('[data-testid="trace-back"]')!.getAttribute('href')).toBe('/studio/traces')
  })

  it('a long preview of a chosen step is clipped with a local "more" toggle; the first failure shows its preview whole', async () => {
    const long = 'fixture-long-line-1\nline 2\nline 3\nline 4\nline 5'
    const main = TRACE.runs[1]!
    const trace = { ...TRACE, runs: [TRACE.runs[0]!, { ...main, spans: [{ ...main.spans[0]!, preview: long }, main.spans[1]!] }] }
    const c = mountAt(`/studio/traces/${SID_A}`, { trace: [200, trace] })
    await waitFor(() => c.querySelectorAll('[data-trace-step]').length === 3, 'steps')
    // The first failure is open in the side panel; its preview is whole and has no toggle.
    expect(c.querySelector('[data-first-failure] pre')!.textContent).toContain('fixture-preview-failed-step')
    expect(c.querySelector('[data-first-failure] [data-testid="step-more"]')).toBeNull()
    const rowsEl = [...c.querySelectorAll<HTMLElement>('[data-trace-step]')]
    const before = calls.length
    act(() => rowsEl[0]!.click())
    const panel = c.querySelector('[data-testid="trace-step-panel"]')!
    const pre = panel.querySelector('[data-testid="step-preview"]')!
    expect(pre.className).toBe('trc-preview trc-preview--ok')
    const more = panel.querySelector<HTMLButtonElement>('[data-testid="step-more"]')!
    expect(more.textContent).toBe('more')
    act(() => more.click())
    expect(pre.className).toContain('trc-preview--open')
    expect(more.textContent).toBe('less')
    expect(calls.length).toBe(before)
    // A short preview has no toggle.
    act(() => rowsEl[1]!.click())
    expect(c.querySelector('[data-testid="trace-step-panel"] [data-testid="step-more"]')).toBeNull()
    // Choosing the first failure again shows the failure card alone, with no jump link.
    act(() => rowsEl[2]!.click())
    expect(c.querySelectorAll('[data-testid="trace-step-panel"]')).toHaveLength(1)
    expect(c.querySelector('[data-testid="trace-step-panel"]')!.hasAttribute('data-first-failure')).toBe(true)
    expect(c.querySelector('[data-testid="trace-first-failure-link"]')).toBeNull()
  })

  it('sends agent_id from the URL', async () => {
    const c = mountAt(`/studio/traces/${SID_A}?agent_id=${SUB}`, { trace: [200, { ...TRACE, agent_id: SUB, runs: [TRACE.runs[0]!] }] })
    await waitFor(() => !!c.querySelector('[data-trace-summary]'), 'summary')
    expect(serveCalls().map((x) => x.url)).toEqual([`${SERVE}/v1/traces/${SID_A}?agent_id=${SUB}`])
  })

  it('says "No failed step" when there is none, and opens the first step', async () => {
    const c = mountAt(`/studio/traces/${SID_A}`, { trace: [200, { ...TRACE, first_failure: null, runs: [TRACE.runs[1]!] }] })
    await waitFor(() => !!c.querySelector('[data-testid="trace-no-failure"]'), 'no failure')
    expect(c.querySelector('[data-testid="trace-no-failure"]')!.textContent).toContain('No failed step')
    expect(c.querySelector('[data-first-failure]')).toBeNull()
    expect(c.querySelector('[data-first-failure-step]')).toBeNull()
    expect(c.querySelector('[data-testid="trace-step-panel"]')!.textContent).toContain('Completed')
  })

  it('MT-14: with ?agent_id= the header counts that run; the session totals sit on a labelled line', async () => {
    const run = TRACE.runs[0]!
    const c = mountAt(`/studio/traces/${SID_A}?agent_id=${SUB}`, { trace: [200, { ...TRACE, agent_id: SUB, runs: [run] }] })
    await waitFor(() => !!c.querySelector('[data-trace-summary]'), 'summary')
    const stats = c.querySelector('[data-testid="trace-stats"]')!
    expect(stats.getAttribute('data-scope')).toBe('run')
    const want = run.n_tool_calls ?? run.spans.length
    expect(stats.querySelector('[data-field="tool_calls"]')!.textContent).toBe(String(want))
    expect(stats.querySelector('[data-field="errors"]')!.textContent).toBe(String(run.errors ?? run.spans.filter((x) => x.ok === false).length))
    expect(stats.querySelector('[data-field="runs"]')!.textContent).toBe(run.is_subagent ? '1 · 1 subagent' : '1')
    expect(stats.querySelector('[data-field="active"]')!.textContent).toBe('—')
    expect(stats.querySelector('[data-field="cost"]')!.textContent).toBe('—')
    expect(c.querySelector('[data-testid="trace-session-totals"]')!.textContent).toBe('Whole session: 3 tool calls · 1 errors · 2 · 1 subagent runs · 5m 0s wall · $1.23')
    expect(c.querySelector('[data-constant="agent"] dd')!.textContent).toBe(SUB)
    // Without agent_id the header is the session, and there is no totals line.
    act(() => root?.unmount())
    document.body.innerHTML = ''
    const w = mountAt(`/studio/traces/${SID_A}`)
    await waitFor(() => !!w.querySelector('[data-trace-summary]'), 'summary')
    expect(w.querySelector('[data-testid="trace-stats"]')!.getAttribute('data-scope')).toBe('session')
    expect(w.querySelector('[data-testid="trace-session-totals"]')).toBeNull()
  })

  it('S3 reads like the artboard: crumb ends with the title, a Step heading, one muted line, no repeated key list', async () => {
    const mcp = { ...TRACE.runs[1]!.spans[0]!, tool: 'mcp__fleet__ci-check', ok: false, intent: 'ci-read', target_kind: null, ts: '2026-11-01T10:03:00.000Z' }
    const trace = { ...TRACE, runs: [{ ...TRACE.runs[1]!, spans: [mcp, TRACE.runs[1]!.spans[1]!] }], first_failure: { agent_id: null, ...mcp }, summary: { ...TRACE.summary!, n_subagent_runs: 0, n_runs: 1 } }
    const c = mountAt(`/studio/traces/${SID_A}`, { trace: [200, trace] })
    await waitFor(() => !!c.querySelector('[data-trace-summary]'), 'summary')
    // The crumb: Studio / traces / use case / title.
    const crumb = c.querySelector('[data-testid="trace-crumb"]')!
    expect(crumb.textContent).toBe('Studio / traces / build / fixture-session-title')
    expect(crumb.textContent).not.toContain(SID_A.slice(0, 8))
    // The runs tile shows subagents only when there are any.
    expect(c.querySelector('[data-field="runs"]')!.textContent).toBe('1')
    // An MCP tool reads as "mcp: server-tool" in the waterfall, in the panel line and in the details.
    expect(c.querySelector('[data-trace-step] .trc-wf__tool')!.textContent).toBe('mcp: fleet-ci-check')
    expect(c.textContent).not.toContain('mcp__')
    // The panel: a Barlow "Step 01" heading, then the card with one muted line and no key list.
    const heading = c.querySelector('.trc-aside .trc-stepblock .trc-aside__title')!
    expect(heading.tagName).toBe('H2')
    expect(heading.textContent).toBe('Step 00')
    const card = c.querySelector('[data-first-failure]')!
    expect(card.querySelector('dl')).toBeNull()
    expect(card.querySelector('[data-testid="trace-step-line"]')!.textContent).toBe('mcp: fleet-ci-check · ci-read · 10:03')
    expect(card.textContent).not.toMatch(/step \d/)
    // The full list lives in Technical details, and a row with no value is left out.
    const tech = c.querySelector('[data-testid="trace-technical"]')!
    expect(tech.closest('details')).not.toBeNull()
    const keys = [...tech.querySelectorAll('dt')].map((d) => d.textContent)
    // MT-16/17: the step only (one run, so no Run row); the run constants live under the title.
    expect(keys).toEqual(['Step', 'Tool', 'Intent', 'Time'])
    expect(c.querySelector('[data-testid="trace-constants"]')!.textContent).toContain('Harness')
    // The view toggle is one joined group with the pressed state on the active item.
    const toggle = c.querySelector('.trc-views')!
    expect(toggle.classList.contains('stu-toggle')).toBe(true)
    expect([...toggle.querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Waterfall', 'true'],
      ['Where time went', 'false'],
    ])
  })

  it('shows the 404 state', async () => {
    const c = mountAt(`/studio/traces/${SID_B}`, { trace: [404, { error: 'no_trajectory' }] })
    await waitFor(() => !!c.querySelector('[data-testid="trace-error"]'), '404')
    expect(c.querySelector('[data-testid="trace-error"]')!.textContent).toBe('This trace is not in the index, or it has no trajectory file.')
    expect(c.querySelector('[data-trace-summary]')).toBeNull()
  })

  it('orders the main run first, then subagents by start time', () => {
    const r = (agent_id: string | null, started_at: string, is_subagent = agent_id !== null) => ({ ...TRACE.runs[0]!, agent_id, started_at, is_subagent })
    expect(orderRuns([r('b', '2026-11-01T10:00:05Z'), r('a', '2026-11-01T10:00:02Z'), r(null, '2026-11-01T10:00:00Z')]).map((x) => x.agent_id)).toEqual([null, 'a', 'b'])
  })
})

describe('network rule (parent ADR-1)', () => {
  it('S2 then S3: trace reads go to the serve only; the TMA API sees no trace text and no session id', async () => {
    const c = mountAt('/studio/traces')
    await waitFor(() => traceRows(c).length === LIST.rows.length, 'rows')
    const link = traceRows(c)[0]!.querySelector<HTMLAnchorElement>('[data-testid="trace-link"]')!
    const t = follow(link, {}, true)
    await waitFor(() => t.querySelectorAll('[data-trace-step]').length === 3, 'S3 steps')
    expect(serveCalls().map((x) => new URL(x.url).pathname)).toEqual(['/v1/traces', `/v1/traces/${SID_A}`])
    const api = assertNetworkRule()
    // The app shell (SessionProvider) loads the profile; S2/S3 add no TMA API request of their own.
    expect(new Set(api)).toEqual(new Set(['GET /me']))
  })

  it('the trace client sends only the bearer, never a body, and keeps the token out of errors and logs', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    const seen: Array<[string, RequestInit]> = []
    const fetchImpl = (async (u: string, init: RequestInit) => {
      seen.push([u, init])
      return json(401, { error: 'invalid_session' })
    }) as unknown as typeof fetch
    const err = await fetchTraceList({ l2_class: 'build' }, { serveUrl: `${SERVE}/`, getToken: () => TOKEN, fetchImpl }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TraceServeError)
    expect((err as TraceServeError).kind).toBe('http')
    expect((err as TraceServeError).status).toBe(401)
    expect((err as TraceServeError).code).toBe('invalid_session')
    expect(String((err as Error).message)).not.toContain(TOKEN)
    expect(seen[0]![0]).toBe(`${SERVE}/v1/traces?limit=50&l2_class=build`)
    expect(seen[0]![1]).toEqual({ method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` }, credentials: 'omit', cache: 'no-store' })
    // No token: no Authorization header at all. Path segments are encoded.
    await fetchTrace('a/b?c', 'x y', { serveUrl: SERVE, getToken: () => null, fetchImpl }).catch(() => undefined)
    expect(seen[1]![0]).toBe(`${SERVE}/v1/traces/a%2Fb%3Fc?agent_id=x+y`)
    expect(seen[1]![1].headers).toEqual({})
    for (const spy of logs) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN)
    expect(traceErrorText(new TraceServeError('not_configured'))).toBe('The trace service is not configured on this build.')
    expect(await fetchTraceList({}, { serveUrl: '', fetchImpl }).catch((e: TraceServeError) => e.kind)).toBe('not_configured')
    expect(seen).toHaveLength(2)
  })
})

describe('studio home link', () => {
  it('shows the Traces link when the serve URL is set', async () => {
    const c = mountAt('/studio')
    await waitFor(() => !!c.querySelector('[data-testid="studio-graders-link"]'), 'home')
    expect(c.querySelector('[data-testid="studio-traces-link"]')!.getAttribute('href')).toBe('/studio/traces')
  })

  it('hides the Traces link when the serve URL is empty', async () => {
    serveState.url = ''
    const c = mountAt('/studio')
    await waitFor(() => !!c.querySelector('[data-testid="studio-graders-link"]'), 'home')
    expect(c.querySelector('[data-testid="studio-traces-link"]')).toBeNull()
  })
})
