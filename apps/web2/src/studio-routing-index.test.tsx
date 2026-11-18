// @vitest-environment jsdom
/**
 * S12 routing index (plan 20261112-tma-c5-studio-area-web2, task C5-RD-S12), route /studio/routing.
 * Mounted through routes.tsx with a stubbed GET /routes, GET /eval-cases and GET /use-cases/:key/compare. Fixture ids
 * and names are synthetic. Proves: one row per use case (cases and routes), the "no route" group, the current and the
 * suggested agent, the verdict, the runs, the cost change and the state; the side panel with the one-line PR diff of
 * the route target (minus = the value at approval time, plus = the new value) and the PR link; the empty diff state
 * before a route exists; the selection; only GET calls and no write control; the pure helpers.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import type { CompareAgent, UseCaseCompareResponse } from './studio/compare'
import { buildRow, changeText, costChange, prDiff, sortRows } from './studio/routing-index'
import type { Route } from './studio/routing'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
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
const KEY_L = `anthropic/model-large#${H('1')}`
const KEY_M = `anthropic/model-medium#${H('2')}`
const KEY_X = `lab-x/model-x#${H('3')}`

const agent = (key: string, over: Partial<CompareAgent> = {}): CompareAgent => ({
  agent_key: key,
  variant_ids: [uuid(1)],
  model_id: key.split('#')[0]!,
  harness: 'claude-code',
  n: 6,
  infra_error_count: 0,
  no_score_runs: 0,
  hard_gate_failures: 0,
  mean_score: 96,
  distribution: null,
  cost_per_task: 0.4,
  cost_label: 'metered',
  median_wall_ms: 1000,
  absolute: { label: 'SAME', reason: null, runs_at_least_same: 6, runs_at_least_close: 6 },
  relative: { label: 'refused', reason: 'is_current_agent', gap: null, mann_whitney: null },
  pareto: { ineligible_reason: null, on_front: true, dominated: false },
  ...over,
})
const PROFILE: UseCaseCompareResponse['profile'] = {
  source: 'defaults', sha256: null, weights: 'stored_per_result', min_runs_per_cell: 5, relative_margin_points: 5, relative_alpha: 0.05, relative_test: 'mann-whitney-u', absolute_bars: { same: 95, close: 85 },
}
const compare = (uc: string, agents: CompareAgent[], current: string | null = null): UseCaseCompareResponse => ({
  use_case: uc, profile: PROFILE, rule_text: { absolute: 'a', relative: 'r' }, current_agent: current, agents,
})
const route = (over: Partial<Route> = {}): Route => ({
  id: uuid(900), tenant: 'tenant-x', use_case_key: 'ops/vps-config', route_target: 'env:DFL_ROUTE_OPS_VPS_CONFIG', target_value: 'cc-large-v3', rollback_value: null,
  model_id: 'anthropic/model-large', agent_sha256: H('1'), harness: 'claude-code', picked_rule: 'absolute', verdict: 'same', n: 6, evidence_run_ids: [uuid(101)],
  compare_profile_sha256: H('e'), policy_version: 'c8-1', state: 'live', pr_url: null, approved_by_actor: 'actor-x', approved_at: '2026-11-01T00:00:00.000Z', ...over,
})

// ops/vps-config: large is live; medium is cheaper and SAME, approved with a PR (swap pending).
const LIVE = route({ id: uuid(901), state: 'live', live_at: '2026-11-02T00:00:00.000Z' })
const PENDING = route({ id: uuid(902), state: 'approved', model_id: 'anthropic/model-medium', agent_sha256: H('2'), target_value: 'cc-medium-v1', rollback_value: 'cc-large-v3', pr_url: 'https://github.com/example-org/example-infra/pull/9' })
const COMPARES: Record<string, UseCaseCompareResponse> = {
  'ops/vps-config': compare('ops/vps-config', [agent(KEY_L), agent(KEY_M, { cost_per_task: 0.08 })], KEY_L),
  // fix/red-ci: no route; model-x passes with 6 runs -> ready to approve.
  'fix/red-ci': compare('fix/red-ci', [agent(KEY_X, { harness: 'opencode', cost_per_task: 0.05 })]),
  // build/ui-component: 3 runs, no verdict -> the "no route" group.
  'build/ui-component': compare('build/ui-component', [agent(KEY_X, { harness: 'opencode', n: 3, absolute: { label: 'refused', reason: 'n_below_minimum', runs_at_least_same: 3, runs_at_least_close: 3 } })]),
}
const CASES = [
  { caseKey: 'c1', useCaseKey: 'ops/vps-config' },
  { caseKey: 'c2', useCaseKey: 'fix/red-ci' },
  { caseKey: 'c3', useCaseKey: 'fix/red-ci' },
  { caseKey: 'c4', useCaseKey: 'build/ui-component' },
  { caseKey: 'c5', useCaseKey: 'not-a-pair' },
]

interface Call { method: string; path: string }
const calls: Call[] = []
function mountAt(path: string, opts: { routes?: [number, unknown] } = {}) {
  saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      calls.push({ method: (input instanceof Request ? input.method : init?.method) ?? 'GET', path: url.pathname + url.search })
      if (url.pathname === '/routes') return json(...(opts.routes ?? [200, { routes: [PENDING, LIVE] }]))
      if (url.pathname === '/eval-cases') return json(200, { cases: CASES })
      const m = /^\/use-cases\/(.+)\/compare$/.exec(url.pathname)
      if (m) {
        const c = COMPARES[decodeURIComponent(m[1]!)]
        return c ? json(200, c) : json(404, { error: 'not_found' })
      }
      return json(404, { error: 'not_found' })
    }),
  )
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />))
  return c
}
const q = (c: HTMLElement, sel: string) => c.querySelector(sel)
const rowOf = (c: HTMLElement, uc: string) => q(c, `[data-testid="s12-index-row"][data-use-case="${uc}"]`)!

describe('S12 routing index /studio/routing', () => {
  it('lists every use case with its agents, verdict, runs, cost and state; the no-route group last', async () => {
    const c = mountAt('/studio/routing')
    await waitFor(() => c.querySelectorAll('[data-testid="s12-index-row"]').length === 3, 'three rows')
    expect([...c.querySelectorAll('[data-testid="s12-index-row"]')].map((r) => r.getAttribute('data-use-case'))).toEqual(['fix/red-ci', 'ops/vps-config', 'build/ui-component'])
    const ops = rowOf(c, 'ops/vps-config')
    expect(ops.textContent).toContain('claude-code · anthropic/model-large')
    expect(ops.textContent).toContain('claude-code · anthropic/model-medium')
    expect(ops.querySelector('[data-testid="s12-index-verdict"]')?.textContent).toBe('same')
    expect(ops.querySelector('[data-testid="s12-index-runs"]')?.textContent).toBe('12')
    expect(ops.textContent).toContain('80% cheaper')
    expect(ops.textContent).toContain('$0.4 → $0.08')
    expect(ops.querySelector('[data-testid="s12-index-state"]')?.textContent).toBe('swap pending')
    expect(ops.querySelector('[data-testid="s12-index-link"]')?.getAttribute('href')).toBe('/studio/routing/ops%2Fvps-config')
    const red = rowOf(c, 'fix/red-ci')
    expect(red.textContent).toContain('default agent')
    expect(red.textContent).toContain('opencode · lab-x/model-x')
    expect(red.textContent).toContain('2 cases')
    expect(red.querySelector('[data-testid="s12-index-state"]')?.textContent).toBe('ready to approve')
    const ui = rowOf(c, 'build/ui-component')
    expect(q(c, '[data-testid="s12-index-no-route"]')?.contains(ui)).toBe(true)
    expect(ui.textContent).toContain('none yet')
    expect(ui.querySelector('[data-testid="s12-index-verdict"]')?.textContent).toBe('too few runs')
    expect(ui.querySelector('[data-testid="s12-index-state"]')?.textContent).toBe('needs runs')
    // Read only: GET calls only, no form field, no write button.
    expect(calls.every((x) => x.method === 'GET')).toBe(true)
    expect(c.querySelectorAll('main input, main textarea, main select, main form')).toHaveLength(0)
    expect(c.textContent).not.toMatch(/\b(Approve|Apply|Save|Run)\b/)
  })

  it('the side panel shows the one-line PR diff of the selected route and its PR link', async () => {
    const c = mountAt('/studio/routing')
    await waitFor(() => !!q(c, '[data-testid="s12-index-panel"]'), 'panel')
    // The first row (fix/red-ci) has no route: the diff explains why it is empty.
    expect(q(c, '[data-testid="s12-index-panel"]')?.getAttribute('data-use-case')).toBe('fix/red-ci')
    expect(q(c, '[data-testid="s12-index-no-diff"]')).not.toBeNull()
    expect(q(c, '[data-testid="s12-index-command"]')).not.toBeNull()
    act(() => (rowOf(c, 'ops/vps-config') as HTMLElement).click())
    const p = q(c, '[data-testid="s12-index-panel"]')!
    expect(p.getAttribute('data-use-case')).toBe('ops/vps-config')
    expect(p.textContent).toContain('Swap anthropic/model-large for anthropic/model-medium')
    expect(p.textContent).toContain('only the model changes')
    const diff = q(c, '[data-testid="s12-index-diff"]')!
    expect([...diff.querySelectorAll('span')].map((s) => s.textContent)).toEqual([
      '# env flag DFL_ROUTE_OPS_VPS_CONFIG (routing targets)',
      '- DFL_ROUTE_OPS_VPS_CONFIG=cc-large-v3',
      '+ DFL_ROUTE_OPS_VPS_CONFIG=cc-medium-v1',
    ])
    expect(q(c, '[data-testid="s12-index-pr"]')?.getAttribute('href')).toBe(PENDING.pr_url)
    expect(q(c, '[data-testid="s12-index-open"]')?.getAttribute('href')).toBe('/studio/routing/ops%2Fvps-config')
  })

  it('a failed GET /routes still lists the use cases from the evidence, with a note', async () => {
    const c = mountAt('/studio/routing', { routes: [503, { error: 'schema_not_ready' }] })
    await waitFor(() => !!q(c, '[data-testid="s12-index-routes-error"]'), 'routes note')
    expect(c.querySelectorAll('[data-testid="s12-index-row"]').length).toBe(3)
    expect(rowOf(c, 'ops/vps-config').querySelector('[data-testid="s12-index-state"]')?.textContent).toBe('ready to approve')
  })

  it('the per-use-case page links back to the index', async () => {
    const c = mountAt('/studio/routing/ops%2Fvps-config')
    await waitFor(() => !!q(c, '[data-testid="s12-index-back"]'), 'back link')
    expect(q(c, '[data-testid="s12-index-back"]')?.getAttribute('href')).toBe('/studio/routing')
  })
})

describe('routing index helpers', () => {
  it('prDiff: env and claude-md lines; an unknown value at approval has no minus line', () => {
    expect(prDiff({ route_target: 'env:FLAG_A', target_value: 'b', rollback_value: 'a' })).toEqual({ file: 'env flag FLAG_A (routing targets)', minus: 'FLAG_A=a', plus: 'FLAG_A=b' })
    expect(prDiff({ route_target: 'claude-md:ops-row', target_value: 'b', rollback_value: null })).toEqual({ file: 'CLAUDE.md row ops-row (routing targets)', minus: null, plus: 'ops-row: b' })
    expect(prDiff({ route_target: 'other', target_value: 'b', rollback_value: null })).toBeNull()
  })
  it('costChange and changeText', () => {
    expect(costChange(0.42, 0.08)).toBe('81% cheaper')
    expect(costChange(0.1, 0.1)).toBe('same cost')
    expect(costChange(0.1, 0.2)).toBe('costs 100% more')
    expect(costChange(null, 0.2)).toBeNull()
    expect(changeText({ model: 'a', harness: 'claude-code', key: null }, { model: 'b', harness: 'claude-code', key: null })).toBe('only the model changes')
    expect(changeText({ model: 'a', harness: 'claude-code', key: null }, { model: 'b', harness: 'codex', key: null })).toBe('the harness and the model change')
    expect(changeText(null, { model: 'b', harness: 'codex', key: null })).toBeNull()
  })
  it('buildRow: a live route whose agent is the recommendation is "keep current"; no data is the no-route group', () => {
    const keep = buildRow('ops/vps-config', 1, [LIVE], compare('ops/vps-config', [agent(KEY_L)], KEY_L))
    expect(keep.keep).toBe(true)
    expect(keep.suggested).toBeNull()
    expect(keep.state).toBe('live')
    const none = buildRow('plan/epic', 1, [], null)
    expect(none.noRoute).toBe(true)
    expect(none.verdict).toBe('no data')
    expect(none.state).toBe('no_route')
    expect(sortRows([none, keep]).noRoute.map((r) => r.useCase)).toEqual(['plan/epic'])
  })
})
