/**
 * Data and pure helpers of the S12 routing index (plan 20261112-tma-c5-studio-area-web2, C5-RD-S12), route /studio/routing.
 * The canvas artboard "S12 Routing recommendation" is a table of every use case with its current agent, the suggested
 * agent, the verdict, the runs, the cost per task and the route state, plus a side panel with the one-line PR diff.
 *
 * Data, all read only: GET /routes (every route of the tenant, newest first), GET /eval-cases (the L1 pairs the caller's
 * cases hold) and GET /use-cases/:key/compare per use case (the agents, their n, verdicts and cost). The suggestion is
 * recommendAgent of routing.ts (the C7 rule: the cheapest agent with a passing verdict and n >= 5); no verdict is computed
 * here. A use case with neither a route nor a passing agent is in the "no route" group.
 */
import { api } from '../lib/api'
import { getUseCaseCompare, type CompareAgent, type UseCaseCompareResponse } from './compare'
import { getAllRoutes, isSwapPending, latestLive, recommendAgent, routeAgentKey, routeVerdictOf, ROUTING_MIN_N, splitTarget, type Recommendation, type Route } from './routing'
import { isL1Pair } from './use-case'

export interface AgentRef {
  model: string
  harness: string | null
  key: string | null
}

export type RowState = 'live' | 'swap_pending' | 'approved' | 'proposed' | 'needs_check' | 'rolled_back' | 'ready' | 'needs_runs' | 'no_route'

export const STATE_TEXT: Record<RowState, string> = {
  live: 'live',
  swap_pending: 'swap pending',
  approved: 'approved',
  proposed: 'proposed',
  needs_check: 'needs check',
  rolled_back: 'rolled back',
  ready: 'ready to approve',
  needs_runs: 'needs runs',
  no_route: 'no route',
}

export interface RoutingRow {
  useCase: string
  /** The cases of the caller in this use case (0 when only a route names it). */
  cases: number
  routes: Route[]
  live: Route | null
  /** The newest route that is not live and not rolled back (approved, proposed or needs_check). */
  pending: Route | null
  compare: UseCaseCompareResponse | null
  rec: Recommendation | null
  current: AgentRef | null
  /** The suggested agent: the pending route, else the recommendation when it is not the live agent. */
  suggested: AgentRef | null
  /** True when the recommendation is the live agent (artboard: "keep current"). */
  keep: boolean
  verdict: string
  /** All counted runs of the use case (the sum of n over its agents). */
  runs: number
  state: RowState
  /** The "no route" group of the artboard: no route row and no passing agent. */
  noRoute: boolean
}

const fromRoute = (r: Route): AgentRef => ({ model: r.model_id, harness: r.harness ?? null, key: routeAgentKey(r) })
const fromAgent = (a: CompareAgent): AgentRef => ({ model: a.model_id, harness: a.harness, key: a.agent_key })

export const agentOf = (row: Pick<RoutingRow, 'compare'>, key: string | null): CompareAgent | null => (key && row.compare ? row.compare.agents.find((a) => a.agent_key === key) ?? null : null)

/** The verdict word of a row: the route's, else the recommendation's, else why there is none. */
function verdictOf(pending: Route | null, live: Route | null, rec: Recommendation | null, compare: UseCaseCompareResponse | null): string {
  const r = pending ?? live
  if (r) return r.verdict
  if (rec) return routeVerdictOf(rec.agent, rec.rules[0]!) ?? 'passes'
  const agents = compare?.agents ?? []
  if (agents.length === 0) return 'no data'
  return agents.some((a) => a.n >= ROUTING_MIN_N) ? 'no agent passes' : 'too few runs'
}

export function buildRow(useCase: string, cases: number, allRoutes: readonly Route[], compare: UseCaseCompareResponse | null): RoutingRow {
  const routes = allRoutes.filter((r) => r.use_case_key === useCase)
  const live = latestLive(routes)
  const pending = routes.find((r) => r.state === 'approved' || r.state === 'proposed' || r.state === 'needs_check') ?? null
  const rec = compare ? recommendAgent(compare.agents) : null
  const liveKey = live ? routeAgentKey(live) : null
  const keep = !pending && !!rec && rec.agent.agent_key === liveKey
  const suggested = pending ? fromRoute(pending) : rec && !keep ? fromAgent(rec.agent) : null
  const runs = (compare?.agents ?? []).reduce((n, a) => n + a.n, 0)
  let state: RowState
  if (pending) state = isSwapPending(pending) ? 'swap_pending' : (pending.state as RowState)
  else if (live) state = 'live'
  else if (rec) state = 'ready'
  else if (routes.some((r) => r.state === 'rolled_back')) state = 'rolled_back'
  else if (runs > 0) state = 'needs_runs'
  else state = 'no_route'
  return {
    useCase,
    cases,
    routes,
    live,
    pending,
    compare,
    rec,
    current: live ? fromRoute(live) : null,
    suggested,
    keep,
    verdict: verdictOf(pending, live, rec, compare),
    runs,
    state,
    noRoute: routes.length === 0 && !rec,
  }
}

/** Rows with a route or a suggestion first, then the "no route" group; inside a group by use case name. */
export function sortRows(rows: RoutingRow[]): { routed: RoutingRow[]; noRoute: RoutingRow[] } {
  const by = (a: RoutingRow, b: RoutingRow) => a.useCase.localeCompare(b.useCase)
  return { routed: rows.filter((r) => !r.noRoute).sort(by), noRoute: rows.filter((r) => r.noRoute).sort(by) }
}

/** "80% cheaper" / "same cost" / "costs 2x more", from two costs per task; null when one is missing or zero. */
export function costChange(from: number | null, to: number | null): string | null {
  if (from === null || to === null || from <= 0) return null
  if (Math.abs(to - from) / from < 0.005) return 'same cost'
  if (to < from) return `${Math.round((1 - to / from) * 100)}% cheaper`
  return `costs ${Math.round((to / from - 1) * 100)}% more`
}

/** What changes between two agents (artboard: "only the model changes"). */
export function changeText(a: AgentRef | null, b: AgentRef | null): string | null {
  if (!a || !b) return null
  if (a.harness && b.harness && a.harness !== b.harness) return a.model === b.model ? 'only the harness changes' : 'the harness and the model change'
  return a.model === b.model ? 'the same model, another agent build' : 'only the model changes'
}

export interface DiffLines {
  file: string
  minus: string | null
  plus: string
}

/**
 * The one line the route PR changes (`tma route pr`): the route target with its value now (rollback_value) and its new
 * value (target_value). env:FLAG is a `FLAG=value` line; claude-md:row is a `row: value` line. Null for another target.
 */
export function prDiff(r: Pick<Route, 'route_target' | 'target_value' | 'rollback_value'>): DiffLines | null {
  const t = splitTarget(r.route_target)
  if (!t) return null
  const line = (v: string) => (t.kind === 'env' ? `${t.name}=${v}` : `${t.name}: ${v}`)
  return {
    file: t.kind === 'env' ? `env flag ${t.name} (routing targets)` : `CLAUDE.md row ${t.name} (routing targets)`,
    minus: r.rollback_value === null ? null : line(r.rollback_value),
    plus: line(r.target_value),
  }
}

export interface RoutingIndex {
  rows: RoutingRow[]
  /** Null when GET /routes failed; its status. */
  routesError: number | null
}

/** Loads the index. A failed compare of one use case leaves that row without agents; a failed /routes leaves every row unrouted. */
export async function loadRoutingIndex(): Promise<RoutingIndex> {
  const [routesR, casesR] = await Promise.allSettled([getAllRoutes(), api.evalCases()])
  const routes = routesR.status === 'fulfilled' && Array.isArray(routesR.value?.routes) ? routesR.value.routes : []
  const routesError = routesR.status === 'rejected' ? ((routesR.reason as { status?: number })?.status ?? 0) : null
  if (casesR.status === 'rejected') throw casesR.reason
  const counts = new Map<string, number>()
  for (const c of casesR.value.cases ?? []) {
    const k = (c as { useCaseKey?: string }).useCaseKey
    if (k && isL1Pair(k)) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  for (const r of routes) if (!counts.has(r.use_case_key)) counts.set(r.use_case_key, 0)
  const rows = await Promise.all(
    [...counts].map(async ([uc, n]) => {
      const live = latestLive(routes.filter((r) => r.use_case_key === uc))
      const compare = await getUseCaseCompare(uc, live ? routeAgentKey(live) : null).catch(() => getUseCaseCompare(uc).catch(() => null))
      return buildRow(uc, n, routes, compare)
    }),
  )
  return { rows, routesError }
}
