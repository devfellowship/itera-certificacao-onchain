// @vitest-environment jsdom
/**
 * S8 agent compare per use case (plan 20261112-tma-c7-model-comparison-per-use-case, task C7-T4).
 * Mounted through routes.tsx (layout, session gate) with a stubbed GET /use-cases/:key/compare and GET /eval-cases.
 * Fixture: the shape of apps/api/src/self-declared/use-case-compare.test.ts (agents x n = 5; one agent with n = 4 →
 * "not enough runs"; one with a hard-gate failure → NOT YET; one with no cost).
 * Proves: one [data-compare-row] per agent with n and both verdict columns; the profile notice reads the response
 * fields; the request encodes the pair (%2F) and passes current_agent; the Pareto chart plots only full, eligible,
 * priced cells and lists the others with a reason; no verdict is recomputed; read only; empty, 503 and 400 states;
 * the links on /agents and the studio home; the picker lists only L1 pairs.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import type { CompareAgent, UseCaseCompareResponse } from './studio/compare'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom's AbortSignal is not Node's, so the data router's `new Request(url, {signal})` throws on a navigate (the
// current-agent select navigates). Test-only shim, as in auth.test.tsx: drop the signal.
const NodeRequest = globalThis.Request
class TestRequest extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {}
    super(input, rest)
  }
}
beforeEach(() => {
  vi.stubGlobal('Request', TestRequest)
})

let root: Root | undefined
let router: ReturnType<typeof createMemoryRouter> | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  router = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
// Below the 5 s test timeout: a failed wait throws here instead of leaking an act() loop into the next test.
async function waitFor(check: () => boolean, label: string, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const H = (c: string) => c.repeat(64)
const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const KEY_A = `anthropic/claude-sonnet-5-5#${H('1')}`
const KEY_B = `zai/glm-5.3#${H('2')}`
const KEY_C = `opencode-go/deepseek-v4-pro#${H('3')}`
const KEY_D = `z-ai/glm-5.3-flash#${H('4')}`
const KEY_E = `openai/gpt-6-mini#${H('5')}`

const agent = (key: string, over: Partial<CompareAgent> = {}): CompareAgent => ({
  agent_key: key,
  variant_ids: [uuid(1)],
  model_id: key.split('#')[0],
  harness: 'opencode',
  n: 5,
  infra_error_count: 0,
  no_score_runs: 0,
  hard_gate_failures: 0,
  mean_score: 96,
  distribution: { min: 92, p10: 93.2, p50: 96, p90: 99, max: 100 },
  cost_per_task: 0.03,
  cost_label: 'metered',
  median_wall_ms: 1020,
  absolute: { label: 'SAME', reason: null, runs_at_least_same: 5, runs_at_least_close: 5 },
  relative: { label: 'refused', reason: 'no_current_agent', gap: null, mann_whitney: null },
  pareto: { ineligible_reason: null, on_front: true, dominated: false },
  ...over,
})

// Neutral rule texts: the read-only check scans the whole page, and these are the API's words.
const RULES = { absolute: 'Absolute rule text of the fixture.', relative: 'Relative rule text of the fixture.' }
const PROFILE: UseCaseCompareResponse['profile'] = {
  source: 'defaults',
  sha256: null,
  weights: 'stored_per_result',
  min_runs_per_cell: 5,
  relative_margin_points: 7,
  relative_alpha: 0.05,
  relative_test: 'mann-whitney-u',
  // Not the library defaults (95 / 85): proves the notice reads the response.
  absolute_bars: { same: 90, close: 80 },
}

/** 3 agents: A full and on the front; B n = 4 (not enough runs); C a hard-gate failure (NOT YET) and no cost. */
const DATA: UseCaseCompareResponse = {
  use_case: 'fix/prod-bug',
  profile: PROFILE,
  rule_text: RULES,
  current_agent: null,
  agents: [
    agent(KEY_A, { infra_error_count: 1 }),
    agent(KEY_B, {
      n: 4,
      mean_score: 99,
      cost_per_task: 0.01,
      cost_label: 'derived',
      absolute: { label: 'refused', reason: 'n_below_minimum', runs_at_least_same: 4, runs_at_least_close: 4 },
      relative: { label: 'refused', reason: 'n_below_minimum', gap: null, mann_whitney: null },
      pareto: { ineligible_reason: null, on_front: true, dominated: null },
    }),
    agent(KEY_C, {
      mean_score: 60,
      hard_gate_failures: 1,
      cost_per_task: null,
      cost_label: null,
      absolute: { label: 'NOT YET', reason: null, runs_at_least_same: 3, runs_at_least_close: 4 },
      pareto: { ineligible_reason: 'hard_gate_failure', on_front: null, dominated: null },
    }),
  ],
}

/** 6 agents for the chart: A and D on the front, E dominated, B n = 4, C hard gate, F no cost. */
const KEY_F = `moonshot/kimi-k3#${H('6')}`
const CHART: UseCaseCompareResponse = {
  ...DATA,
  current_agent: KEY_A,
  agents: [
    ...DATA.agents.map((a) =>
      a.agent_key === KEY_A ? { ...a, relative: { label: 'refused' as const, reason: 'is_current_agent' as const, gap: null, mann_whitney: null } } : a,
    ),
    agent(KEY_D, { mean_score: 85, cost_per_task: 0.005, cost_label: 'derived', absolute: { label: 'CLOSE', reason: null, runs_at_least_same: 1, runs_at_least_close: 5 } }),
    // The response says `better` for an agent whose mean score is LOWER than the current agent's: the page shows it.
    agent(KEY_E, {
      mean_score: 70,
      cost_per_task: 0.04,
      absolute: { label: 'NOT YET', reason: null, runs_at_least_same: 0, runs_at_least_close: 1 },
      relative: { label: 'better', reason: null, gap: -26, mann_whitney: { u: 3, p: 0.0317, method: 'exact' } },
      pareto: { ineligible_reason: null, on_front: false, dominated: true },
    }),
    agent(KEY_F, { cost_per_task: null, cost_label: null, pareto: { ineligible_reason: 'no_cost', on_front: null, dominated: null } }),
  ],
}

const CASES = {
  cases: [
    { caseKey: 'c1', useCaseKey: 'fix/prod-bug', id: 'id1' },
    { caseKey: 'c2', useCaseKey: 'fix/prod-bug', id: 'id2' },
    { caseKey: 'c3', useCaseKey: 'build/feature', id: 'id3' },
    { caseKey: 'c4', useCaseKey: 'fix', id: 'id4' },
    { caseKey: 'c5', useCaseKey: 'made/up-pair', id: 'id5' },
  ],
  limit: 200,
  truncated: false,
}

const calls: string[] = []
function mountAt(path: string, answer: [number, unknown] | ((url: URL) => [number, unknown]) = [200, DATA]) {
  saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw)
      calls.push(raw)
      // Any path under /use-cases/…/compare answers, so a missing %2F fails on the URL assertion, not on a 404.
      if (url.pathname.startsWith('/use-cases/') && url.pathname.endsWith('/compare')) return json(...(typeof answer === 'function' ? answer(url) : answer))
      if (url.pathname === '/eval-cases') return json(200, CASES)
      return json(404, { error: 'not found' })
    }),
  )
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  router = createMemoryRouter(routes, { initialEntries: [path] })
  act(() => root!.render(<RouterProvider router={router!} />))
  return c
}
const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-compare-row]')]
const row = (c: HTMLElement, key: string) => rows(c).find((r) => r.dataset.agentKey === key)!
const cell = (r: HTMLElement, id: string) => r.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const PAGE = '/studio/compare?use_case=fix%2Fprod-bug'

describe('S8 table', () => {
  it('renders one [data-compare-row] per agent, each with its n and both verdict columns', async () => {
    const c = mountAt(PAGE)
    await waitFor(() => rows(c).length > 0, 'rows')
    expect(rows(c)).toHaveLength(3)
    expect(c.querySelectorAll('[data-testid="s8-row"]')).toHaveLength(3)
    expect(c.querySelector('h1')!.textContent).toBe('fix/prod-bug')
    for (const r of rows(c)) {
      expect(cell(r, 's8-n').textContent).toMatch(/n \d/)
      expect(cell(r, 's8-absolute')).not.toBeNull()
      expect(cell(r, 's8-relative')).not.toBeNull()
      expect(cell(r, 's8-absolute').getAttribute('title')).toBe(RULES.absolute)
      expect(cell(r, 's8-relative').getAttribute('title')).toBe(RULES.relative)
    }
    expect(cell(row(c, KEY_A), 's8-n').textContent).toBe('n 51 excluded (infra)')
    expect(cell(row(c, KEY_B), 's8-n').textContent).toBe('n 4')
    expect(cell(row(c, KEY_A), 's8-absolute').textContent).toMatch(/^SAME/)
    expect(cell(row(c, KEY_C), 's8-absolute').textContent).toMatch(/^NOT YET/)
    expect(cell(row(c, KEY_C), 's8-gates').textContent).toBe('1')
    expect(cell(row(c, KEY_A), 's8-dist').textContent).toBe('92 / 93.2 / 96 / 99 / 100')
    expect(cell(row(c, KEY_A), 's8-cost').textContent).toBe('$0.03 metered')
    expect(cell(row(c, KEY_B), 's8-cost').textContent).toBe('$0.01 derived')
    expect(cell(row(c, KEY_C), 's8-cost').textContent).toBe('no cost')
    // The n = 4 cell shows its numbers and "not enough runs", never a SAME / CLOSE label.
    const b = cell(row(c, KEY_B), 's8-absolute')
    expect(b.textContent).toMatch(/^not enough runs/)
    expect(b.textContent).toContain('4 of 4')
    expect(b.textContent).not.toMatch(/SAME|CLOSE/)
    expect(cell(row(c, KEY_B), 's8-relative').textContent).toBe('not enough runs')
    expect(cell(row(c, KEY_B), 's8-pareto-cell').textContent).toBe('not enough runs')
    // No current agent on the first load: the relative column shows what the response sends.
    expect(cell(row(c, KEY_A), 's8-relative').textContent).toBe('no current agent')
    // The rule texts are visible without hover, and each info mark is focusable and points at its text.
    expect(c.querySelector('[data-testid="s8-rules"]')!.textContent).toContain(RULES.absolute)
    const info = c.querySelector<HTMLElement>('[data-testid="s8-info-relative"]')!
    expect(info.tabIndex).toBe(0)
    expect(document.getElementById(info.getAttribute('aria-describedby')!)!.textContent).toBe(RULES.relative)
    // Provider badge from the model id prefix.
    expect(cell(row(c, KEY_A), 's8-provider').textContent).toBe('anthropic/')
  })
})

describe('S8 profile notice', () => {
  it('names the stored per-run weights and the default bars, with the numbers of the response', async () => {
    const c = mountAt(PAGE)
    await waitFor(() => !!c.querySelector('[data-testid="s8-profile-notice"]'), 'notice')
    const t = c.querySelector('[data-testid="s8-profile-notice"]')!.textContent!
    expect(t).toContain('Scores use the weights that each run stored when it was graded.')
    expect(t).toContain('Default thresholds: SAME at 90, CLOSE at 80; margin 7 points; at least 5 runs per cell.')
    expect(t).toContain('These are the default bars, not a per-use-case weight profile pinned from dfl-evals.')
    expect(t).not.toContain('95')
  })

  it('a pinned profile shows its source and the first 12 characters of its sha256, and never says default', async () => {
    const sha = 'abc123def456' + 'f'.repeat(52)
    const c = mountAt(PAGE, [200, { ...DATA, profile: { ...PROFILE, source: 'pinned', sha256: sha } }])
    await waitFor(() => !!c.querySelector('[data-testid="s8-profile-notice"]'), 'notice')
    const t = c.querySelector('[data-testid="s8-profile-notice"]')!.textContent!
    expect(t).toContain('Profile pinned, sha256 abc123def456.')
    expect(t).not.toContain(sha.slice(0, 13))
    expect(t.toLowerCase()).not.toContain('default')
    expect(t).toContain('SAME at 90, CLOSE at 80')
  })
})

describe('S8 request', () => {
  it('encodes the pair as %2F, and passes current_agent after a current agent is chosen', async () => {
    const c = mountAt(PAGE, (url) => [200, url.searchParams.get('current_agent') ? { ...DATA, current_agent: url.searchParams.get('current_agent') } : DATA])
    await waitFor(() => rows(c).length === 3, 'rows')
    const first = calls.find((u) => u.includes('/use-cases/'))!
    expect(first).toContain('/use-cases/fix%2Fprod-bug/compare')
    expect(first).not.toContain('/use-cases/fix/prod-bug')
    expect(first).not.toContain('current_agent=')
    const select = c.querySelector<HTMLSelectElement>('[data-testid="s8-current-select"]')!
    expect(select.value).toBe('')
    act(() => {
      select.value = KEY_A
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitFor(() => calls.some((u) => u.includes('current_agent=')), 'second call')
    const second = calls.filter((u) => u.includes('/use-cases/')).at(-1)!
    expect(second).toContain('/use-cases/fix%2Fprod-bug/compare?current_agent=')
    expect(new URL(second).searchParams.get('current_agent')).toBe(KEY_A)
    expect(router!.state.location.search).toBe(`?use_case=fix%2Fprod-bug&current=${encodeURIComponent(KEY_A).replace(/%20/g, '+')}`)
    await waitFor(() => row(c, KEY_A)?.dataset.current === 'true', 'current row')
  })
})

describe('S8 Pareto chart', () => {
  it('plots only full, eligible, priced cells; lists the others with their reason; marks the front', async () => {
    const c = mountAt(PAGE, [200, CHART])
    await waitFor(() => !!c.querySelector('[data-testid="s8-pareto-svg"]'), 'chart')
    const points = [...c.querySelectorAll<SVGGElement>('[data-testid="s8-point"]')]
    expect(points.map((p) => p.getAttribute('data-agent-key')).sort()).toEqual([KEY_A, KEY_D, KEY_E].sort())
    const kind = (k: string) => points.find((p) => p.getAttribute('data-agent-key') === k)!.getAttribute('data-pareto')
    expect(kind(KEY_A)).toBe('front')
    expect(kind(KEY_D)).toBe('front')
    expect(kind(KEY_E)).toBe('dominated')
    // Shape, not only colour: front points are diamonds (rect), the dominated one a circle.
    expect(points.find((p) => p.getAttribute('data-agent-key') === KEY_A)!.querySelector('rect')).not.toBeNull()
    expect(points.find((p) => p.getAttribute('data-agent-key') === KEY_E)!.querySelector('circle')).not.toBeNull()
    for (const p of points) {
      expect(p.querySelector('title')!.textContent).toContain(p.querySelector('text')!.textContent!)
    }
    expect(c.querySelector('[data-testid="s8-front-line"]')).not.toBeNull()
    const skipped = Object.fromEntries(
      [...c.querySelectorAll<HTMLElement>('[data-testid="s8-not-plotted-item"]')].map((li) => [li.dataset.agentKey, li.textContent]),
    )
    expect(Object.keys(skipped).sort()).toEqual([KEY_B, KEY_C, KEY_F].sort())
    expect(skipped[KEY_B]).toContain('not enough runs (n 4 of 5)')
    expect(skipped[KEY_C]).toContain('hard-gate failure')
    expect(skipped[KEY_F]).toContain('no cost')
  })

  it('never recomputes a verdict: a lower score with `better` in the response renders `better`', async () => {
    const c = mountAt(PAGE, [200, CHART])
    await waitFor(() => rows(c).length === 6, 'rows')
    const e = cell(row(c, KEY_E), 's8-relative')
    expect(e.dataset.label).toBe('better')
    expect(e.textContent).toMatch(/^better/)
    expect(e.textContent).toContain('gap -26 pts')
    expect(e.textContent).toContain('Mann-Whitney p 0.0317 (exact)')
    expect(cell(row(c, KEY_E), 's8-pareto-cell').textContent).toBe('dominated')
    expect(cell(row(c, KEY_A), 's8-relative').textContent).toBe('current agent')
    expect(cell(row(c, KEY_D), 's8-absolute').textContent).toMatch(/^CLOSE/)
  })
})

describe('S8 read only', () => {
  it('no Run, Save or Route word in the page text, and no button but the copy command', async () => {
    for (const body of [DATA, CHART, { ...DATA, agents: [] }]) {
      const c = mountAt(PAGE, [200, body])
      await waitFor(() => !!c.querySelector('[data-copy-command]'), 'copy command')
      const main = c.querySelector('main')!
      expect(main.textContent).not.toMatch(/\b(Run|Save|Route)\b/)
      const buttons = [...main.querySelectorAll('button')]
      expect(buttons.map((b) => b.textContent)).toEqual(['Copy command'])
      for (const el of main.querySelectorAll('a, button')) expect(el.textContent ?? '').not.toMatch(/Run|Save|Route|Pick/)
      expect(main.querySelector('form')).toBeNull()
      const cmd = c.querySelector('[data-testid="copy-command-text"]')!.textContent!
      expect(cmd).toContain('tma eval run --case eval/<case key> --variant <variant.json> --repeat 5')
      expect(cmd).toContain('tma eval upload --case eval/<case key>')
      act(() => root?.unmount())
      root = undefined
      document.body.innerHTML = ''
    }
  })
})

describe('S8 states', () => {
  it('agents: [] shows the empty state and the copy command', async () => {
    const c = mountAt(PAGE, [200, { ...DATA, agents: [] }])
    await waitFor(() => !!c.querySelector('[data-testid="s8-empty"]'), 'empty')
    expect(c.querySelector('[data-testid="s8-empty"]')!.textContent).toContain('No runs for this use case yet.')
    expect(c.querySelector('[data-copy-command]')).not.toBeNull()
    expect(rows(c)).toHaveLength(0)
  })

  it('503 shows the not-migrated text', async () => {
    const c = mountAt(PAGE, [503, { error: 'schema_not_ready' }])
    await waitFor(() => !!c.querySelector('[data-testid="s8-error"]'), 'error')
    expect(c.querySelector('[data-testid="s8-load-error"]')!.textContent).toContain('not migrated')
  })

  it('400 on a bad use case shows the invalid-pair text', async () => {
    const c = mountAt('/studio/compare?use_case=not-a-pair', [400, { error: 'invalid_use_case' }])
    await waitFor(() => !!c.querySelector('[data-testid="s8-error"]'), 'error')
    expect(calls.find((u) => u.includes('/use-cases/'))).toContain('/use-cases/not-a-pair/compare')
    expect(c.querySelector('[data-testid="s8-load-error"]')!.textContent).toContain('This is not a use case pair.')
  })
})

describe('S8 links and picker', () => {
  it('the picker lists only the L1 pairs of the caller cases, each a link to its compare page', async () => {
    const c = mountAt('/studio/compare')
    await waitFor(() => !!c.querySelector('[data-testid="s8-picker"]'), 'picker')
    const links = [...c.querySelectorAll<HTMLAnchorElement>('[data-testid="s8-use-case-link"]')]
    expect(links.map((a) => a.textContent)).toEqual(['build/feature', 'fix/prod-bug'])
    expect(links[1].getAttribute('href')).toBe('/studio/compare?use_case=fix%2Fprod-bug')
    expect(calls.some((u) => u.includes('/use-cases/'))).toBe(false)
  })

  it('the studio home links to the compare screen', async () => {
    const c = mountAt('/studio')
    await waitFor(() => !!c.querySelector('[data-testid="studio-compare-link"]'), 'home link')
    expect(c.querySelector('[data-testid="studio-compare-link"]')!.getAttribute('href')).toBe('/studio/compare')
  })

  it('/agents shows the "Compare per use case" link', async () => {
    const c = mountAt('/agents', () => [200, {}])
    // /agents loads the ranking; the 404 of the stub is enough for the page shell that carries the link.
    await waitFor(() => !!c.querySelector('[data-testid="studio-compare-use-case"]'), 'agents link')
    const a = c.querySelector('[data-testid="studio-compare-use-case"]')!
    expect(a.getAttribute('href')).toBe('/studio/compare')
    expect(a.textContent).toBe('Compare per use case')
  })
})
