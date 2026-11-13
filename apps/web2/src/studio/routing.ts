/**
 * Types, calls and pure helpers of studio S12, the routing screen per use case (plan 20261112-tma-c8-routing-from-evals,
 * task C8-T3; ADR-1: the studio writes only the verdict; ADR-5: the person picks the rule).
 *
 * Data: GET /routes?use_case= and POST /routes/approve (C8-T2, apps/api/src/self-declared/routes.ts), and the S8
 * compare response (compare.ts). The verdicts come from the compare response; this module never computes one. It
 * only reads whether a label the API sent passes under a rule (the table ROUTE_PASSING_VERDICTS of
 * packages/contracts/route.js, mirrored below because route.js reads its schema with node:fs and cannot load in the
 * browser; a test keeps the copy equal to the contract). The API checks the same table again on approve.
 */
import type { Route, RouteRule } from '@itera/contracts'
import { request } from '../lib/api'
import type { CompareAgent } from './compare'

export type { Route, RouteRule }

/** ROUTE_MIN_N of packages/contracts/route.js: the smallest n per cell that may back a route. */
export const ROUTING_MIN_N = 5
/** ROUTE_PASSING_VERDICTS of packages/contracts/route.js (route verdict vocabulary, lower case). */
export const ROUTING_PASSING: Readonly<Record<RouteRule, readonly string[]>> = Object.freeze({
  absolute: Object.freeze(['same', 'close']),
  relative: Object.freeze(['better', 'same']),
})
export const ROUTING_RULES: readonly RouteRule[] = ['absolute', 'relative']

/** The route verdict of a compare cell under a rule (cellVerdict of routes.ts): null when the library refused. */
export function routeVerdictOf(a: CompareAgent, rule: RouteRule): string | null {
  if (rule === 'absolute') return ({ SAME: 'same', CLOSE: 'close', 'NOT YET': 'not_yet' } as Record<string, string>)[a.absolute.label] ?? null
  return ({ better: 'better', tie: 'same', worse: 'worse' } as Record<string, string>)[a.relative.label] ?? null
}

/** True when the label the API sent for this cell passes under the rule. */
export function passesUnder(a: CompareAgent, rule: RouteRule): boolean {
  const v = routeVerdictOf(a, rule)
  return v !== null && ROUTING_PASSING[rule].includes(v)
}

export interface Recommendation {
  agent: CompareAgent
  /** The rules under which its verdict passes (one or both). */
  rules: RouteRule[]
}

/**
 * The C7 recommendation: the cheapest agent that holds a passing verdict under either rule with n >= 5. An agent with
 * no cost sorts after every priced one; a tie in cost goes to the higher mean score, then to the agent key. Null when
 * no cell qualifies.
 */
export function recommendAgent(agents: readonly CompareAgent[]): Recommendation | null {
  const candidates = agents
    .filter((a) => a.n >= ROUTING_MIN_N)
    .map((a) => ({ agent: a, rules: ROUTING_RULES.filter((r) => passesUnder(a, r)) }))
    .filter((c) => c.rules.length > 0)
  candidates.sort((x, y) => {
    const cx = x.agent.cost_per_task ?? Infinity
    const cy = y.agent.cost_per_task ?? Infinity
    if (cx !== cy) return cx - cy
    const sx = x.agent.mean_score ?? -Infinity
    const sy = y.agent.mean_score ?? -Infinity
    if (sx !== sy) return sy - sx
    return x.agent.agent_key < y.agent.agent_key ? -1 : x.agent.agent_key > y.agent.agent_key ? 1 : 0
  })
  return candidates[0] ?? null
}

/** The compare agent key of a route row (`<model_id>#<agent_sha256>`, agentKeyOf of use-case-compare.ts). */
export const routeAgentKey = (r: Pick<Route, 'model_id' | 'agent_sha256'>) => `${r.model_id}#${r.agent_sha256}`

/** The latest live route (GET /routes answers newest first), or null. */
export const latestLive = (routes: readonly Route[]): Route | null => routes.find((r) => r.state === 'live') ?? null

export interface EvidenceIds {
  /** The run ids the API would freeze for this agent and rule (as far as the compare response lists them). */
  ids: string[]
  /** The full count of counted runs behind `ids` (the sum of evidence_run_count of the sides). */
  total: number
}

/**
 * The evidence run ids of `agent` under `rule`, as POST /routes/approve freezes them: the agent's counted runs, and
 * under the relative rule also those of the current agent it is compared with (when that is another agent). Null when
 * the compare response has no evidence_run_ids (an older API): the screen then falls back to GET /eval-runs.
 */
export function evidenceIdsOf(agent: CompareAgent, agents: readonly CompareAgent[], currentAgent: string | null, rule: RouteRule): EvidenceIds | null {
  if (!agent.evidence_run_ids) return null
  const sides = [agent]
  if (rule === 'relative' && currentAgent && currentAgent !== agent.agent_key) {
    const cur = agents.find((a) => a.agent_key === currentAgent)
    if (cur?.evidence_run_ids) sides.push(cur)
  }
  const ids = [...new Set(sides.flatMap((a) => a.evidence_run_ids ?? []))]
  const total = sides.reduce((sum, a) => sum + (a.evidence_run_count ?? a.evidence_run_ids?.length ?? 0), 0)
  return { ids, total: Math.max(total, ids.length) }
}

/** The kit command that opens the PR of an approved route (services/runner/src/cli/commands/route.ts, `tma route pr`). */
export const routePrCommand = (id: string) => `tma route pr --route ${id} --targets <targets.json> --repo-dir <infra checkout>`

// The CHECK patterns of POST /routes/approve (ROUTE_TARGET_RE and VALUE_RE of routes.ts). The API checks them again.
export type TargetKind = 'env' | 'claude-md'
export const TARGET_NAME_RE: Record<TargetKind, RegExp> = {
  env: /^[A-Z][A-Z0-9_]{1,63}$/,
  'claude-md': /^[a-z0-9][a-z0-9_-]{0,63}$/,
}
export const TARGET_VALUE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/

/** Split `env:FLAG` / `claude-md:row` into its kind and name, or null for another text. */
export function splitTarget(target: string): { kind: TargetKind; name: string } | null {
  const m = /^(env|claude-md):(.+)$/.exec(target)
  return m ? { kind: m[1] as TargetKind, name: m[2]! } : null
}

export interface TargetInput {
  kind: TargetKind
  name: string
  value: string
  /** Empty = not known (null). */
  rollback: string
}

/** The problems of the target inputs, in words (empty = valid). */
export function targetProblems(t: TargetInput): string[] {
  const out: string[] = []
  if (!TARGET_NAME_RE[t.kind].test(t.name)) {
    out.push(t.kind === 'env' ? 'The flag name must be upper case: A-Z, 0-9 and _, 2 to 64 characters.' : 'The row name must be lower case: a-z, 0-9, _ and -, at most 64 characters.')
  }
  if (!TARGET_VALUE_RE.test(t.value)) out.push('The target value must be lower case: a-z, 0-9, _ . : and -, at most 64 characters.')
  if (t.rollback !== '' && !TARGET_VALUE_RE.test(t.rollback)) out.push('The rollback value must be empty or use the same characters as the target value.')
  return out
}

export interface ApproveBody {
  use_case: string
  agent: string
  current_agent: string | null
  picked_rule: RouteRule
  route_target: string
  target_value: string
  rollback_value: string | null
  fallback_agent?: string
}

export function approveBody(input: {
  useCase: string
  agent: string
  currentAgent: string | null
  rule: RouteRule
  target: TargetInput
  fallbackAgent?: string | null
}): ApproveBody {
  const body: ApproveBody = {
    use_case: input.useCase,
    agent: input.agent,
    current_agent: input.currentAgent,
    picked_rule: input.rule,
    route_target: `${input.target.kind}:${input.target.name}`,
    target_value: input.target.value,
    rollback_value: input.target.rollback === '' ? null : input.target.rollback,
  }
  if (input.fallbackAgent) body.fallback_agent = input.fallbackAgent
  return body
}

/** Why the approve control is off for this agent and rule (empty = it may post). */
export function approveBlockers(a: CompareAgent | null, rule: RouteRule, verdictText: string): string[] {
  if (!a) return ['Pick an agent.']
  const out: string[] = []
  if (a.n < ROUTING_MIN_N) out.push(`This cell has n ${a.n}; a route needs at least ${ROUTING_MIN_N} runs per cell.`)
  if (!passesUnder(a, rule)) {
    out.push(
      rule === 'absolute'
        ? `The absolute verdict is ${verdictText}; a route under the absolute rule needs SAME or CLOSE.`
        : `The relative verdict is ${verdictText}; a route under the relative rule needs better or same.`,
    )
  }
  return out
}

/** GET /routes?use_case=: the routes of the use case, newest first. */
export const getRoutes = (useCase: string) => request<{ routes: Route[] }>('/routes', { query: { use_case: useCase } })

/** POST /routes/approve: 201 with the new row in state `approved`. */
export const postApproveRoute = (body: ApproveBody) => request<Route>('/routes/approve', { method: 'POST', body: JSON.stringify(body) })
