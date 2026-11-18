/**
 * S1 Studio home redesign (plan 20261112-tma-c5-studio-area-web2, task C5-RD-S1; canvas artboard "ToBeHome"):
 * the use-case table, its summary columns from the S8 compare response and the S12 routes, and the view controls.
 */
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompareAgent, UseCaseCompareResponse } from './studio/compare'
import { agentLetters, costText, passesVerdict, scoreText, summarizeUseCase, type UseCaseSummary } from './studio/home'
import type { Route } from './studio/routing'
import { StudioHomePage } from './studio/StudioHomePage'

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})
function mount(el: React.ReactElement) {
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(el))
  return c
}

function agent(key: string, over: Partial<CompareAgent> = {}): CompareAgent {
  return {
    agent_key: key,
    variant_ids: [],
    model_id: key.split('#')[0],
    harness: 'claude-code',
    n: 5,
    infra_error_count: 0,
    no_score_runs: 0,
    hard_gate_failures: 0,
    mean_score: 80,
    distribution: null,
    cost_per_task: 0.1,
    cost_label: 'metered',
    median_wall_ms: 1000,
    absolute: { label: 'NOT YET', reason: null, runs_at_least_same: 0, runs_at_least_close: 0 },
    relative: { label: 'worse', reason: null, gap: null, mann_whitney: null },
    pareto: { ineligible_reason: null, on_front: true, dominated: false },
    ...over,
  }
}
const compare = (agents: CompareAgent[]): UseCaseCompareResponse => ({
  use_case: 'fix/red-ci',
  profile: { source: 'default', sha256: null, weights: 'weighted', min_runs_per_cell: 5, relative_margin_points: 3, relative_alpha: 0.05, relative_test: 'mann-whitney', absolute_bars: { same: 90, close: 80 } },
  rule_text: { absolute: 'a', relative: 'r' },
  current_agent: null,
  agents,
})
const route = (over: Partial<Route> = {}) =>
  ({ id: 'r1', state: 'live', model_id: 'anthropic/claude-sonnet-5.5', agent_sha256: 'a'.repeat(64), harness: 'claude-code', fallback_model_id: null, ...over }) as Route

describe('summarizeUseCase', () => {
  it('takes the best score over the agents and the labels of the recommended (cheapest passing) agent', () => {
    const s = summarizeUseCase(
      compare([
        agent('big#1', { mean_score: 92, cost_per_task: 0.42, absolute: { label: 'SAME', reason: null, runs_at_least_same: 5, runs_at_least_close: 5 }, relative: { label: 'tie', reason: null, gap: 0, mann_whitney: null } }),
        agent('mid#2', { mean_score: 89, cost_per_task: 0.08, absolute: { label: 'CLOSE', reason: null, runs_at_least_same: 3, runs_at_least_close: 5 }, relative: { label: 'tie', reason: null, gap: 1, mann_whitney: null } }),
        agent('small#3', { mean_score: 58, cost_per_task: 0.004 }),
      ]),
      [route({ state: 'rolled_back', model_id: 'old' }), route({ fallback_model_id: 'anthropic/claude-opus-5.5' })],
    )
    expect(s.bestScore).toBe(92)
    expect(s.costPerTask).toBe(0.08)
    expect(s.verdict).toBe('close')
    expect(s.relative).toBe('tie')
    expect(s.routeModel).toBe('anthropic/claude-sonnet-5.5')
    expect(s.routeHarness).toBe('claude-code')
    expect(s.fallbackModel).toBe('anthropic/claude-opus-5.5')
  })

  it('says "not yet" when no agent passes a rule with n >= 5, and the cost of the best agent', () => {
    const s = summarizeUseCase(compare([agent('a#1', { n: 4, mean_score: 70, cost_per_task: 0.3, absolute: { label: 'SAME', reason: null, runs_at_least_same: 4, runs_at_least_close: 4 } })]), [])
    expect(s.verdict).toBe('not yet')
    expect(s.relative).toBeNull()
    expect(s.costPerTask).toBe(0.3)
    expect(s.routeModel).toBeNull()
  })

  it('shows no value when the calls failed', () => {
    expect(summarizeUseCase(null, null)).toMatchObject({ bestScore: null, costPerTask: null, verdict: null, routeModel: null, agents: 0 })
  })

  it('formats the cells', () => {
    expect(scoreText(88.6)).toBe('89')
    expect(scoreText(null)).toBe('—')
    expect(costText(0.08)).toBe('$0.08')
    expect(costText(0.004)).toBe('$0.004')
    expect(costText(null)).toBe('—')
    expect(agentLetters('claude-code')).toBe('CC')
    expect(agentLetters('opencode')).toBe('OC')
    expect(passesVerdict(undefined, 'all')).toBe(true)
    expect(passesVerdict(undefined, 'same')).toBe(false)
  })
})

const SUM = (over: Partial<UseCaseSummary>): UseCaseSummary => ({ bestScore: 88, costPerTask: 0.31, verdict: 'close', relative: 'tie', routeModel: null, routeHarness: null, fallbackModel: null, agents: 2, ...over })

describe('S1 use-case table', () => {
  const cases = [
    { caseKey: 'ci-001', useCaseKey: 'fix/red-ci', id: 'c1' },
    { caseKey: 'ci-002', useCaseKey: 'fix/red-ci', id: 'c2' },
    { caseKey: 'verify-001', useCaseKey: 'verify/prod-verify', id: 'c3' },
  ]
  const summaries = {
    'fix/red-ci': SUM({ routeModel: 'anthropic/claude-opus-5.5', routeHarness: 'claude-code', fallbackModel: 'anthropic/claude-sonnet-5.5' }),
    'verify/prod-verify': SUM({ bestScore: 90, costPerTask: 0.05, verdict: 'same', relative: 'better' }),
  }

  it('renders one row per use case with the artboard columns and its case links', () => {
    const c = mount(
      <MemoryRouter>
        <StudioHomePage cases={cases} summaries={summaries} />
      </MemoryRouter>,
    )
    expect(c.querySelector('h1')?.textContent).toBe('Use cases')
    const row = c.querySelector('[data-testid="use-case-fix/red-ci"]')!
    expect(row.querySelector('[data-testid="s1-cases"]')?.textContent).toBe('2')
    expect(row.querySelector('[data-testid="s1-best-score"]')?.textContent).toBe('88')
    expect(row.querySelector('[data-testid="s1-cost"]')?.textContent).toBe('$0.31')
    expect(row.querySelector('[data-testid="s1-verdict"]')?.textContent).toContain('close')
    expect(row.querySelector('[data-testid="s1-verdict"]')?.textContent).toContain('tie')
    expect(row.querySelector('[data-testid="s1-route"]')?.textContent).toContain('claude-opus-5.5')
    expect(row.querySelector('[data-testid="s1-route-fallback"]')?.textContent).toContain('claude-sonnet-5.5')
    expect(row.querySelector('[data-testid="s1-use-case-link"]')?.getAttribute('href')).toBe('/studio/compare?use_case=fix%2Fred-ci')
    expect([...row.querySelectorAll('[data-testid="studio-case-link"]')].map((a) => a.getAttribute('href'))).toEqual(['/studio/cases/c1', '/studio/cases/c2'])
    expect(c.querySelector('[data-testid="use-case-verify/prod-verify"] [data-testid="s1-route-none"]')?.textContent).toContain('default agent')
    expect(c.querySelector('[data-testid="use-case-verify"]')?.textContent).toContain('verify · 1')
  })

  it('the Verdict filter keeps the rows with that verdict; Group none drops the group rows; no button, no Save or Run', () => {
    const c = mount(
      <MemoryRouter>
        <StudioHomePage cases={cases} summaries={summaries} />
      </MemoryRouter>,
    )
    const pick = (id: string, v: string) =>
      act(() => {
        const sel = c.querySelector<HTMLSelectElement>(`[data-testid="${id}"]`)!
        sel.value = v
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      })
    pick('s1-verdict-filter', 'same')
    expect(c.querySelector('[data-testid="use-case-fix/red-ci"]')).toBeNull()
    expect(c.querySelector('[data-testid="use-case-verify/prod-verify"]')).not.toBeNull()
    pick('s1-verdict-filter', 'not yet')
    expect(c.querySelector('[data-testid="s1-filter-empty"]')).not.toBeNull()
    pick('s1-verdict-filter', 'all')
    pick('s1-group', 'none')
    expect(c.querySelector('[data-testid="use-case-fix"]')).toBeNull()
    expect(c.querySelectorAll('[data-testid^="use-case-"][data-testid*="/"]')).toHaveLength(2)
    expect(c.querySelectorAll('button')).toHaveLength(0)
    expect(c.textContent).not.toMatch(/\b(Save|Run)\b/)
  })
})
