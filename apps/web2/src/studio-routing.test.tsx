// @vitest-environment jsdom
/**
 * S12 routing per use case (plan 20261112-tma-c8-routing-from-evals, task C8-T3).
 * Mounted through routes.tsx (layout, session gate) with a stubbed GET /routes, GET /use-cases/:key/compare,
 * GET /eval-runs and POST /routes/approve. Fixture ids and names are synthetic.
 * Proves: the current route, the recommendation and both verdicts; the evidence links; approve disabled at n = 4 and on
 * a NOT YET cell under absolute; approve posts the exact body; a 400 shows the API message; after 201 the copy
 * command holds the id; no Apply / Run / Save text; the recommendation helper; the S8 link; the evidence list from the
 * compare response's evidence_run_ids (per rule, unlinked ids, the cut line); "live since" and the rollback PR link of a
 * tma-route/2 row. Swap (Q d881e5df = C, Q b5c4ba38 = B): a pending row (approved + pr_url) shows the applied route it
 * would replace, its PR and two buttons; approve and reject post {decision} to POST /routes/:id/swap and reload the
 * routes; a 403 not_a_human_actor shows the sign-in text (also on the approve-route control); isSwapPending equals
 * the contract.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'
import type { CompareAgent, UseCaseCompareResponse } from './studio/compare'
import { routingHref } from './studio/links'
import {
  approveBlockers, evidenceIdsOf, isSwapPending, NOT_A_HUMAN_TEXT, recommendAgent, ROUTING_MIN_N, ROUTING_PASSING, targetProblems, type Route,
} from './studio/routing'

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
const KEY_A = `anthropic/model-a#${H('1')}`
const KEY_B = `lab-b/model-b#${H('2')}`
const KEY_C = `lab-c/model-c#${H('3')}`
const KEY_D = `lab-d/model-d#${H('4')}`

const agent = (key: string, over: Partial<CompareAgent> = {}): CompareAgent => ({
  agent_key: key,
  variant_ids: [uuid(1)],
  model_id: key.split('#')[0]!,
  harness: 'opencode',
  n: 5,
  infra_error_count: 0,
  no_score_runs: 0,
  hard_gate_failures: 0,
  mean_score: 96,
  distribution: { min: 92, p10: 93, p50: 96, p90: 99, max: 100 },
  cost_per_task: 0.03,
  cost_label: 'metered',
  median_wall_ms: 1000,
  absolute: { label: 'SAME', reason: null, runs_at_least_same: 5, runs_at_least_close: 5 },
  relative: { label: 'refused', reason: 'is_current_agent', gap: null, mann_whitney: null },
  pareto: { ineligible_reason: null, on_front: true, dominated: false },
  ...over,
})

const PROFILE: UseCaseCompareResponse['profile'] = {
  source: 'defaults',
  sha256: null,
  weights: 'stored_per_result',
  min_runs_per_cell: 5,
  relative_margin_points: 7,
  relative_alpha: 0.05,
  relative_test: 'mann-whitney-u',
  absolute_bars: { same: 90, close: 80 },
}

/**
 * A: the live agent, SAME, $0.03 metered. B: n = 4, cheapest (refused). C: NOT YET under absolute but `better` under
 * relative, $0.02 derived → the recommendation. D: NOT YET and worse.
 */
const DATA: UseCaseCompareResponse = {
  use_case: 'fix/prod-bug',
  profile: PROFILE,
  rule_text: { absolute: 'Absolute rule text of the fixture.', relative: 'Relative rule text of the fixture.' },
  current_agent: KEY_A,
  agents: [
    agent(KEY_A, { variant_ids: [uuid(1)] }),
    agent(KEY_B, {
      variant_ids: [uuid(2)],
      n: 4,
      cost_per_task: 0.001,
      absolute: { label: 'refused', reason: 'n_below_minimum', runs_at_least_same: 4, runs_at_least_close: 4 },
      relative: { label: 'refused', reason: 'n_below_minimum', gap: null, mann_whitney: null },
    }),
    agent(KEY_C, {
      variant_ids: [uuid(3)],
      mean_score: 88,
      cost_per_task: 0.02,
      cost_label: 'derived',
      absolute: { label: 'NOT YET', reason: null, runs_at_least_same: 2, runs_at_least_close: 4 },
      relative: { label: 'better', reason: null, gap: 8, mann_whitney: { u: 2, p: 0.02, method: 'exact' } },
    }),
    agent(KEY_D, {
      variant_ids: [uuid(4)],
      mean_score: 40,
      cost_per_task: 0.01,
      absolute: { label: 'NOT YET', reason: null, runs_at_least_same: 0, runs_at_least_close: 0 },
      relative: { label: 'worse', reason: null, gap: -50, mann_whitney: { u: 0, p: 0.01, method: 'exact' } },
    }),
  ],
}

const route = (over: Partial<Route> = {}): Route => ({
  id: uuid(900),
  tenant: 'tenant-x',
  use_case_key: 'fix/prod-bug',
  route_target: 'env:DFL_ROUTE_EXAMPLE',
  target_value: 'model-a',
  rollback_value: 'model-z',
  model_id: 'anthropic/model-a',
  agent_sha256: H('1'),
  picked_rule: 'absolute',
  verdict: 'same',
  n: 5,
  evidence_run_ids: [uuid(101)],
  compare_profile_sha256: H('e'),
  policy_version: 'c8-1',
  state: 'live',
  pr_url: 'https://github.com/example-org/example-infra/pull/7',
  approved_by_actor: 'actor-x',
  approved_at: '2026-11-01T00:00:00.000Z',
  ...over,
})

const run = (id: number, variant: number, over: Record<string, unknown> = {}) => ({
  id: uuid(id),
  evaluationId: uuid(500 + id),
  agentId: null,
  agentName: null,
  seq: 1,
  status: 'pass',
  score: 90,
  infraOk: true,
  startedAt: '2026-11-01T00:00:00.000Z',
  caseId: uuid(300),
  caseKey: 'case-1',
  useCaseKey: 'fix/prod-bug',
  variant: { id: uuid(variant), agentSha256: H('9'), agent: {}, variantSha256: H('8'), label: 'v', changeKind: 'none', isBaseline: true },
  predictionSha256: null,
  ...over,
})

const RUNS = {
  runs: [
    run(31, 3),
    run(32, 3),
    run(33, 3, { infraOk: false }),
    run(34, 3, { useCaseKey: 'build/feature' }),
    run(35, 3, { evaluationId: null }),
    run(11, 1),
  ],
  limit: 200,
  truncated: false,
}

type Answer = [number, unknown]
interface Stub {
  routes?: Answer | (() => Answer)
  swap?: Answer
  compare?: Answer | ((url: URL) => Answer)
  approve?: Answer
}
const calls: { url: string; method: string; body: string | null }[] = []
function mountAt(path: string, stub: Stub = {}) {
  saveSession({ token: 'tok', user: { id: 'u-1', email: 'person@example.com' } })
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw)
      calls.push({ url: raw, method: init?.method ?? 'GET', body: (init?.body as string | undefined) ?? null })
      if (url.pathname === '/routes/approve') return json(...(stub.approve ?? [201, route({ id: uuid(901), state: 'approved', pr_url: null })]))
      if (/^\/routes\/[^/]+\/swap$/.test(url.pathname)) return json(...(stub.swap ?? [200, { status: 'swapped', route: route(), retired: [] }]))
      if (url.pathname === '/routes') {
        const r = stub.routes ?? [200, { routes: [route()] }]
        return json(...(typeof r === 'function' ? r() : r))
      }
      if (url.pathname.startsWith('/use-cases/') && url.pathname.endsWith('/compare')) {
        const c = stub.compare ?? [200, DATA]
        return json(...(typeof c === 'function' ? c(url) : c))
      }
      if (url.pathname === '/eval-runs') return json(200, RUNS)
      if (url.pathname === '/eval-cases') return json(200, { cases: [], limit: 200, truncated: false })
      return json(404, { error: 'not found' })
    }),
  )
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  act(() => root!.render(<RouterProvider router={router} />))
  return c
}
const PAGE = '/studio/routing/fix%2Fprod-bug'
const q = <T extends HTMLElement = HTMLElement>(c: HTMLElement, id: string) => c.querySelector<T>(`[data-testid="${id}"]`)
const ready = (c: HTMLElement) => waitFor(() => !!q(c, 's12-approve') || !!q(c, 's12-error'), 'S12')

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  act(() => {
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
const click = (el: HTMLElement) => act(() => el.click())
const approve = (c: HTMLElement) => q<HTMLButtonElement>(c, 's12-approve')!

describe('S12 screen', () => {
  it('renders the current route, the recommendation and both verdicts of the recommended agent', async () => {
    const c = mountAt(PAGE)
    await ready(c)
    expect(c.querySelector('h1')!.textContent).toBe('fix/prod-bug')
    const cur = q(c, 's12-current')!
    expect(cur.dataset.state).toBe('live')
    expect(cur.textContent).toContain('env:DFL_ROUTE_EXAMPLE = model-a')
    expect(cur.querySelector('[data-testid="s12-pr-link"]')!.getAttribute('href')).toBe('https://github.com/example-org/example-infra/pull/7')
    // The live agent is the current agent of the compare request; the pair is one encoded path segment.
    const compareCall = calls.find((x) => x.url.includes('/use-cases/'))!
    expect(compareCall.url).toContain('/use-cases/fix%2Fprod-bug/compare')
    expect(new URL(compareCall.url).searchParams.get('current_agent')).toBe(KEY_A)
    expect(calls.find((x) => new URL(x.url).pathname === '/routes')!.url).toContain('use_case=fix%2Fprod-bug')
    // C is the cheapest passing agent with n >= 5 (B is cheaper but n = 4; D does not pass).
    expect(q(c, 's12-recommendation')!.dataset.agentKey).toBe(KEY_C)
    expect(q(c, 's12-recommendation')!.textContent).toContain('passes under the relative rule')
    expect(q(c, 's12-agent')!.dataset.agentKey).toBe(KEY_C)
    expect(q(c, 's12-verdict-absolute')!.dataset.label).toBe('NOT YET')
    expect(q(c, 's12-verdict-absolute')!.textContent).toContain('NOT YET')
    expect(q(c, 's12-verdict-relative')!.dataset.label).toBe('better')
    expect(q(c, 's12-verdict-relative')!.textContent).toContain('better')
    expect(q(c, 's12-n')!.textContent).toBe('5')
    expect(q(c, 's12-cost')!.textContent).toBe('$0.02 derived')
    expect(q(c, 's12-policy')!.textContent).toBe('c8-1')
    // Evidence: one link per counted run of the agent's variants in this use case, each to /evaluations/:eid.
    const links = [...c.querySelectorAll<HTMLAnchorElement>('[data-testid="s12-evidence-link"]')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/evaluations/${uuid(531)}`, `/evaluations/${uuid(532)}`])
    expect(c.querySelectorAll('[data-testid="s12-evidence-unlinked"]')).toHaveLength(1)
  })

  it('without evidence_run_ids (an older API) the evidence falls back to GET /eval-runs, with no cut line', async () => {
    const c = mountAt(PAGE)
    await ready(c)
    expect(q(c, 's12-evidence-cut')).toBeNull()
    expect(q(c, 's12-live-since')).toBeNull()
    expect(q(c, 's12-rollback-pr-link')).toBeNull()
  })

  it('lists exactly the evidence_run_ids of the compare response; under relative also the current agent ids', async () => {
    const withIds: UseCaseCompareResponse = {
      ...DATA,
      agents: DATA.agents.map((a) =>
        a.agent_key === KEY_C
          ? { ...a, evidence_run_ids: [uuid(32), uuid(35), uuid(77)], evidence_run_count: 3 }
          : a.agent_key === KEY_A
            ? { ...a, evidence_run_ids: [uuid(11)], evidence_run_count: 1 }
            : a,
      ),
    }
    const c = mountAt(PAGE, { compare: [200, withIds] })
    await ready(c)
    const ids = () => [...c.querySelectorAll<HTMLElement>('[data-testid="s12-evidence"] [data-run-id]')].map((e) => e.dataset.runId)
    const linked = () => [...c.querySelectorAll<HTMLElement>('[data-testid="s12-evidence-link"]')].map((e) => e.dataset.runId)
    const unlinked = () => [...c.querySelectorAll<HTMLElement>('[data-testid="s12-evidence-unlinked"]')].map((e) => e.dataset.runId)
    // Absolute: C's ids only. Run 31 is C's in GET /eval-runs but not counted by the API, so it is not listed.
    expect(ids()).toEqual([uuid(32), uuid(35), uuid(77)])
    expect(linked()).toEqual([uuid(32)])
    expect(c.querySelector<HTMLAnchorElement>('[data-testid="s12-evidence-link"]')!.getAttribute('href')).toBe(`/evaluations/${uuid(532)}`)
    // 35 has an eval-runs row with no evaluation; 77 has no eval-runs row at all.
    expect(unlinked()).toEqual([uuid(35), uuid(77)])
    expect(q(c, 's12-evidence')!.textContent).toContain('not in your latest results list')
    expect(q(c, 's12-evidence-cut')).toBeNull()
    // Relative: plus the current agent (A) ids, as the API freezes them.
    click(q(c, 's12-rule-relative')!)
    expect(ids()).toEqual([uuid(32), uuid(35), uuid(77), uuid(11)])
    expect(linked()).toEqual([uuid(32), uuid(11)])
  })

  it('shows "showing N of M runs" when the API cut the list', async () => {
    const cut: UseCaseCompareResponse = {
      ...DATA,
      agents: DATA.agents.map((a) => (a.agent_key === KEY_C ? { ...a, evidence_run_ids: [uuid(31), uuid(32)], evidence_run_count: 640 } : a)),
    }
    const c = mountAt(PAGE, { compare: [200, cut] })
    await ready(c)
    expect(q(c, 's12-evidence-cut')!.textContent).toBe('showing 2 of 640 runs')
  })

  it('shows "live since" and the rollback PR link of a tma-route/2 live row', async () => {
    const v2 = route({
      format: 'tma-route/2',
      live_at: '2026-11-02T09:30:00.000Z',
      rollback_pr_url: 'https://github.com/example-org/example-infra/pull/8',
      rolled_back_at: null,
    })
    const c = mountAt(PAGE, { routes: [200, { routes: [v2] }] })
    await ready(c)
    const cur = q(c, 's12-current')!
    expect(cur.querySelector('[data-testid="s12-live-since"]')!.textContent).toBe('live since 2026-11-02')
    expect(cur.querySelector('[data-testid="s12-rollback-pr-link"]')!.getAttribute('href')).toBe('https://github.com/example-org/example-infra/pull/8')
  })

  it('shows "default (no live route)" when no route is live', async () => {
    const c = mountAt(PAGE, { routes: [200, { routes: [route({ state: 'rolled_back' })] }], compare: [200, { ...DATA, current_agent: null }] })
    await ready(c)
    expect(q(c, 's12-current')!.textContent).toContain('default (no live route)')
    expect(new URL(calls.find((x) => x.url.includes('/use-cases/'))!.url).searchParams.get('current_agent')).toBeNull()
  })

  it('a live agent that is not in the caller runs falls back to no current agent', async () => {
    const c = mountAt(PAGE, {
      compare: (url) => (url.searchParams.get('current_agent') ? [400, { error: 'unknown_current_agent' }] : [200, { ...DATA, current_agent: null }]),
    })
    await ready(c)
    expect(calls.filter((x) => x.url.includes('/use-cases/'))).toHaveLength(2)
    expect(q(c, 's12-recommendation')).not.toBeNull()
  })

  it('disables approve at n = 4, with the reason', async () => {
    const c = mountAt(PAGE)
    await ready(c)
    setValue(q<HTMLSelectElement>(c, 's12-agent-select')!, KEY_B)
    setValue(q<HTMLInputElement>(c, 's12-target-name')!, 'DFL_ROUTE_EXAMPLE')
    setValue(q<HTMLInputElement>(c, 's12-target-value')!, 'model-b')
    expect(approve(c).disabled).toBe(true)
    expect(q(c, 's12-approve-reasons')!.textContent).toContain('n 4; a route needs at least 5 runs per cell')
    // The "more samples" hint is a copy command, not a control that starts anything.
    expect(q(c, 's12-more-samples')!.querySelector('pre')!.textContent).toContain('--repeat 1')
  })

  it('disables approve on a NOT YET cell under absolute, and enables it under relative', async () => {
    const c = mountAt(PAGE)
    await ready(c)
    setValue(q<HTMLInputElement>(c, 's12-target-name')!, 'DFL_ROUTE_EXAMPLE')
    setValue(q<HTMLInputElement>(c, 's12-target-value')!, 'model-c')
    expect(q<HTMLInputElement>(c, 's12-rule-absolute')!.checked).toBe(true)
    expect(approve(c).disabled).toBe(true)
    expect(q(c, 's12-approve-reasons')!.textContent).toContain('The absolute verdict is NOT YET')
    click(q(c, 's12-rule-relative')!)
    expect(approve(c).disabled).toBe(false)
    expect(q(c, 's12-approve-reasons')).toBeNull()
  })

  it('disables approve while a target input does not match the API pattern', async () => {
    const c = mountAt(PAGE)
    await ready(c)
    click(q(c, 's12-rule-relative')!)
    setValue(q<HTMLInputElement>(c, 's12-target-name')!, 'lower_case')
    setValue(q<HTMLInputElement>(c, 's12-target-value')!, 'model-c')
    expect(approve(c).disabled).toBe(true)
    expect(q(c, 's12-approve-reasons')!.textContent).toContain('flag name must be upper case')
  })

  it('posts the exact body, then shows the route id, state approved and the copy command', async () => {
    const c = mountAt(PAGE)
    await ready(c)
    // Prefilled from the live route: its target and its value as the rollback value.
    expect(q<HTMLInputElement>(c, 's12-target-name')!.value).toBe('DFL_ROUTE_EXAMPLE')
    expect(q<HTMLInputElement>(c, 's12-rollback-value')!.value).toBe('model-a')
    click(q(c, 's12-rule-relative')!)
    setValue(q<HTMLInputElement>(c, 's12-target-value')!, 'model-c')
    click(approve(c))
    await waitFor(() => !!q(c, 's12-approved'), 'approved')
    const post = calls.find((x) => x.method === 'POST')!
    expect(new URL(post.url).pathname).toBe('/routes/approve')
    expect(JSON.parse(post.body!)).toEqual({
      use_case: 'fix/prod-bug',
      agent: KEY_C,
      current_agent: KEY_A,
      picked_rule: 'relative',
      route_target: 'env:DFL_ROUTE_EXAMPLE',
      target_value: 'model-c',
      rollback_value: 'model-a',
    })
    expect(q(c, 's12-route-id')!.textContent).toBe(uuid(901))
    expect(q(c, 's12-route-state')!.textContent).toBe('approved')
    const cmd = q(c, 's12-copy-command')!
    expect(cmd.querySelector('pre')!.textContent).toBe(`tma route pr --route ${uuid(901)} --targets <targets.json> --repo-dir <infra checkout>`)
    expect(cmd.querySelector('button')!.textContent).toBe('Copy command')
    expect(q(c, 's12-approve')).toBeNull()
  })

  it('sends rollback_value null when the rollback input is empty, and the fallback agent when one is picked', async () => {
    const c = mountAt(PAGE, { routes: [200, { routes: [] }], compare: [200, { ...DATA, current_agent: null }] })
    await ready(c)
    click(q(c, 's12-rule-relative')!)
    // With no current agent the relative verdict of C is still what the fixture sends: the page shows the response.
    setValue(q<HTMLSelectElement>(c, 's12-target-kind')!, 'claude-md')
    setValue(q<HTMLInputElement>(c, 's12-target-name')!, 'planning')
    setValue(q<HTMLInputElement>(c, 's12-target-value')!, 'model-c')
    setValue(q<HTMLSelectElement>(c, 's12-fallback')!, KEY_A)
    click(approve(c))
    await waitFor(() => !!q(c, 's12-approved'), 'approved')
    expect(JSON.parse(calls.find((x) => x.method === 'POST')!.body!)).toEqual({
      use_case: 'fix/prod-bug',
      agent: KEY_C,
      current_agent: null,
      picked_rule: 'relative',
      route_target: 'claude-md:planning',
      target_value: 'model-c',
      rollback_value: null,
      fallback_agent: KEY_A,
    })
  })

  it('a 400 from the API shows its message', async () => {
    const c = mountAt(PAGE, { approve: [400, { error: 'invalid_body', message: 'target_value is not valid' }] })
    await ready(c)
    click(q(c, 's12-rule-relative')!)
    setValue(q<HTMLInputElement>(c, 's12-target-value')!, 'model-c')
    click(approve(c))
    await waitFor(() => !!q(c, 's12-approve-error'), 'error')
    expect(q(c, 's12-approve-error')!.textContent).toBe('target_value is not valid (invalid_body)')
    expect(q(c, 's12-approved')).toBeNull()
    expect(approve(c).disabled).toBe(false)
  })

  it('has no Apply, Run or Save text and only the approve and copy buttons', async () => {
    const c = mountAt(PAGE)
    await ready(c)
    const check = (page: HTMLElement) => {
      // The S12 page itself (the app nav above it is not part of S12).
      const root = page.querySelector<HTMLElement>('[data-testid="studio-routing"]')!
      const clone = root.cloneNode(true) as HTMLElement
      // A copy command is the exact kit text (it may hold `tma eval run`); it is selectable text, not a control.
      clone.querySelectorAll('[data-copy-command] pre').forEach((p) => p.remove())
      for (const el of clone.querySelectorAll<HTMLElement>('*')) {
        expect(el.textContent ?? '', el.outerHTML.slice(0, 80)).not.toMatch(/\b(apply|run|save)\b/i)
      }
      for (const b of root.querySelectorAll('button')) expect(['Approve route', 'Copy command']).toContain(b.textContent)
    }
    check(c)
    setValue(q<HTMLSelectElement>(c, 's12-agent-select')!, KEY_B)
    check(c)
    click(q(c, 's12-rule-relative')!)
    setValue(q<HTMLSelectElement>(c, 's12-agent-select')!, KEY_C)
    setValue(q<HTMLInputElement>(c, 's12-target-value')!, 'model-c')
    click(approve(c))
    await waitFor(() => !!q(c, 's12-approved'), 'approved')
    check(c)
  })

  it('a 503 on the compare call shows the not-migrated state', async () => {
    const c = mountAt(PAGE, { compare: [503, { error: 'schema_not_ready' }] })
    await ready(c)
    expect(q(c, 's12-error')!.dataset.status).toBe('503')
  })

  it('S8 links to S12 for its use case', async () => {
    const c = mountAt('/studio/compare?use_case=fix%2Fprod-bug')
    await waitFor(() => !!q(c, 's8-routing-link'), 'S8 link')
    expect(q(c, 's8-routing-link')!.getAttribute('href')).toBe('/studio/routing/fix%2Fprod-bug')
    expect(routingHref('plan/write-plan')).toBe('/studio/routing/plan%2Fwrite-plan')
  })
})

describe('S12 swap pending (Q d881e5df = C)', () => {
  const PENDING_ID = uuid(902)
  const PENDING_PR = 'https://github.com/example-org/example-infra/pull/8'
  const pendingRoute = route({ id: PENDING_ID, state: 'approved', pr_url: PENDING_PR, model_id: 'lab-c/model-c', agent_sha256: H('3'), target_value: 'model-c' })
  const withPending = { routes: [200, { routes: [pendingRoute, route()] }] as Answer }
  const swapCalls = () => calls.filter((x) => new URL(x.url).pathname.endsWith('/swap'))
  const routeReads = () => calls.filter((x) => new URL(x.url).pathname === '/routes').length

  it('a pending row shows the applied route it would replace, its PR, and both buttons', async () => {
    const c = mountAt(PAGE, withPending)
    await ready(c)
    const block = q(c, 's12-swap-pending')!
    expect(block.dataset.routeId).toBe(PENDING_ID)
    expect(block.textContent).toContain('Swap pending')
    const applied = q(block, 's12-swap-applied')!
    expect(applied.dataset.routeId).toBe(uuid(900))
    expect(applied.textContent).toContain(uuid(900).slice(0, 8))
    expect(applied.textContent).toContain('anthropic/model-a')
    expect(applied.textContent).toContain('live')
    expect(q(block, 's12-swap-pr-link')!.getAttribute('href')).toBe(PENDING_PR)
    expect(q(block, 's12-swap-approve')!.textContent).toBe('Approve swap')
    expect(q(block, 's12-swap-reject')!.textContent).toBe('Reject swap')
    // Only the pending row has the block; the live row has none.
    expect(c.querySelectorAll('[data-testid="s12-swap-pending"]')).toHaveLength(1)
  })

  it('"Approve swap" posts {decision: "approve"} to POST /routes/:id/swap and reloads the routes', async () => {
    let swapped = false
    const c = mountAt(PAGE, {
      routes: () => [200, { routes: swapped ? [{ ...pendingRoute, state: 'live' }, route({ state: 'rolled_back' })] : [pendingRoute, route()] }],
    })
    await ready(c)
    const before = routeReads()
    swapped = true
    click(q(c, 's12-swap-approve')!)
    await waitFor(() => !q(c, 's12-swap-pending'), 'reload')
    expect(swapCalls()).toHaveLength(1)
    expect(swapCalls()[0]!.method).toBe('POST')
    expect(new URL(swapCalls()[0]!.url).pathname).toBe(`/routes/${PENDING_ID}/swap`)
    expect(JSON.parse(swapCalls()[0]!.body!)).toEqual({ decision: 'approve' })
    expect(routeReads()).toBe(before + 1)
    expect(q(c, 's12-current')!.textContent).toContain('lab-c/model-c')
  })

  it('"Reject swap" posts {decision: "reject"}', async () => {
    const c = mountAt(PAGE, { ...withPending, swap: [200, { status: 'swap_rejected', route: { ...pendingRoute, pr_url: null } }] })
    await ready(c)
    click(q(c, 's12-swap-reject')!)
    await waitFor(() => swapCalls().length === 1, 'swap call')
    expect(JSON.parse(swapCalls()[0]!.body!)).toEqual({ decision: 'reject' })
    expect(new URL(swapCalls()[0]!.url).pathname).toBe(`/routes/${PENDING_ID}/swap`)
  })

  it('a 403 not_a_human_actor shows the sign-in text; the routes stay as they were', async () => {
    const c = mountAt(PAGE, { ...withPending, swap: [403, { error: 'not_a_human_actor', message: "only a person's login may approve a route; sign in again with your own DFL login" }] })
    await ready(c)
    const before = routeReads()
    click(q(c, 's12-swap-approve')!)
    await waitFor(() => !!q(c, 's12-swap-error'), 'error')
    expect(q(c, 's12-swap-error')!.textContent).toBe("Only a person's own login can approve. Sign in again.")
    expect(q(c, 's12-swap-error')!.textContent).toBe(NOT_A_HUMAN_TEXT)
    expect(routeReads()).toBe(before)
    expect(q(c, 's12-swap-pending')).not.toBeNull()
  })

  it('the approve-route control shows the same text on a 403 not_a_human_actor', async () => {
    const c = mountAt(PAGE, { approve: [403, { error: 'not_a_human_actor', message: 'x' }] })
    await ready(c)
    click(q(c, 's12-rule-relative')!)
    setValue(q<HTMLInputElement>(c, 's12-target-value')!, 'model-c')
    click(approve(c))
    await waitFor(() => !!q(c, 's12-approve-error'), 'error')
    expect(q(c, 's12-approve-error')!.textContent).toBe(NOT_A_HUMAN_TEXT)
  })

  it('the pending block has no Apply, Run or Save text', async () => {
    const c = mountAt(PAGE, withPending)
    await ready(c)
    for (const el of q(c, 's12-swap-pending')!.querySelectorAll<HTMLElement>('*')) {
      expect(el.textContent ?? '').not.toMatch(/\b(apply|run|save)\b/i)
    }
    const page = q(c, 'studio-routing')!
    for (const b of page.querySelectorAll('button')) expect(['Approve route', 'Copy command', 'Approve swap', 'Reject swap']).toContain(b.textContent)
  })

  it('isSwapPending equals the contract (packages/contracts/route.js)', () => {
    const src = readFileSync(resolve(process.cwd(), '../../packages/contracts/route.js'), 'utf-8')
    expect(src).toContain("return !!route && route.state === 'approved' && typeof route.pr_url === 'string' && route.pr_url.length > 0;")
    expect(isSwapPending({ state: 'approved', pr_url: PENDING_PR })).toBe(true)
    expect(isSwapPending({ state: 'approved', pr_url: null })).toBe(false)
    expect(isSwapPending({ state: 'live', pr_url: PENDING_PR })).toBe(false)
    expect(isSwapPending(null)).toBe(false)
  })
})

describe('evidenceIdsOf', () => {
  const a = agent(KEY_C, { evidence_run_ids: [uuid(1), uuid(2)], evidence_run_count: 2 })
  const cur = agent(KEY_A, { evidence_run_ids: [uuid(3)], evidence_run_count: 700 })
  it('is null without the field (the fallback path)', () => {
    expect(evidenceIdsOf(agent(KEY_C), [], KEY_A, 'absolute')).toBeNull()
  })
  it('absolute: the agent ids; relative: plus the current agent ids and counts', () => {
    expect(evidenceIdsOf(a, [a, cur], KEY_A, 'absolute')).toEqual({ ids: [uuid(1), uuid(2)], total: 2 })
    expect(evidenceIdsOf(a, [a, cur], KEY_A, 'relative')).toEqual({ ids: [uuid(1), uuid(2), uuid(3)], total: 702 })
    // The agent is the current agent: one side only.
    expect(evidenceIdsOf(cur, [a, cur], KEY_A, 'relative')).toEqual({ ids: [uuid(3)], total: 700 })
    expect(evidenceIdsOf(a, [a, cur], null, 'relative')).toEqual({ ids: [uuid(1), uuid(2)], total: 2 })
  })
})

describe('recommendAgent', () => {
  it('picks the cheapest agent that passes under either rule', () => {
    const r = recommendAgent(DATA.agents)!
    expect(r.agent.agent_key).toBe(KEY_C)
    expect(r.rules).toEqual(['relative'])
    const both = recommendAgent([agent(KEY_A, { cost_per_task: 0.5, relative: { label: 'tie', reason: null, gap: 1, mann_whitney: null } })])!
    expect(both.rules).toEqual(['absolute', 'relative'])
  })

  it('returns null when no cell passes', () => {
    expect(recommendAgent([DATA.agents[3]!])).toBeNull()
    expect(recommendAgent([])).toBeNull()
  })

  it('excludes a cell with n < 5 even when its label passes and it is cheapest', () => {
    const small = agent(KEY_B, { n: 4, cost_per_task: 0.0001 })
    expect(recommendAgent([small, agent(KEY_A)])!.agent.agent_key).toBe(KEY_A)
    expect(recommendAgent([small])).toBeNull()
  })

  it('sorts an agent with no cost after a priced one, and breaks a cost tie by mean score', () => {
    expect(recommendAgent([agent(KEY_A, { cost_per_task: null, cost_label: null }), agent(KEY_B, { cost_per_task: 9 })])!.agent.agent_key).toBe(KEY_B)
    expect(recommendAgent([agent(KEY_A, { mean_score: 90 }), agent(KEY_B, { mean_score: 95 })])!.agent.agent_key).toBe(KEY_B)
  })

  it('the passing table and the minimum n equal the contract (packages/contracts/route.js)', () => {
    // route.js reads its schema with node:fs at import time, which the vite transform cannot load: read its source.
    const src = readFileSync(resolve(process.cwd(), '../../packages/contracts/route.js'), 'utf-8')
    expect(src).toContain(`export const ROUTE_MIN_N = ${ROUTING_MIN_N};`)
    const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ')
    expect(src).toContain(
      `ROUTE_PASSING_VERDICTS = Object.freeze({ absolute: Object.freeze([${list(ROUTING_PASSING.absolute)}]), relative: Object.freeze([${list(ROUTING_PASSING.relative)}]) });`,
    )
  })

  it('approveBlockers and targetProblems name each reason', () => {
    expect(approveBlockers(null, 'absolute', '')).toEqual(['Pick an agent.'])
    expect(approveBlockers(agent(KEY_A), 'absolute', 'SAME')).toEqual([])
    expect(targetProblems({ kind: 'env', name: 'DFL_X', value: 'sonnet', rollback: '' })).toEqual([])
    expect(targetProblems({ kind: 'claude-md', name: 'Planning', value: 'Sonnet 5', rollback: 'x y' })).toHaveLength(3)
  })
})
