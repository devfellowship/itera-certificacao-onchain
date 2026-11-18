/**
 * Pure helpers of S1, the studio home (plan 20261112-tma-c5-studio-area-web2, task C5-RD-S1; canvas artboard "ToBeHome").
 * One row per use case (an L1 pair): cases, best score, cost per task, verdict, route agent. The numbers come from the
 * S8 compare response (GET /use-cases/:key/compare) and the route rows (GET /routes?use_case=). Every verdict is the
 * label the API sent (ADR-7 of C7): this module only picks which agent's labels the row shows (the C7 recommendation
 * of routing.ts) and formats them.
 */
import type { CompareAgent, UseCaseCompareResponse } from './compare'
import { latestLive, recommendAgent, type Route } from './routing'

/** What one use-case row shows besides its cases. `null` fields render as a dash. */
export interface UseCaseSummary {
  /** The highest mean score over the agents of the use case. */
  bestScore: number | null
  /** The cost per task of the recommended agent, else of the best-scoring agent. */
  costPerTask: number | null
  /** The absolute verdict (Q-T22 = C: both rules show). 'not yet' when no agent passes either rule with n >= 5. */
  verdict: 'same' | 'close' | 'not yet' | null
  /** The relative verdict label of the same agent, as the API sent it. */
  relative: string | null
  /** The model of the latest live route, or null (the workspace default agent). */
  routeModel: string | null
  routeHarness: string | null
  /** The fallback model of that route (canvas: the indented second tile), or null. */
  fallbackModel: string | null
  /** Agents counted in the compare response. */
  agents: number
}

const absoluteText = (a: CompareAgent): 'same' | 'close' | 'not yet' =>
  a.absolute.label === 'SAME' ? 'same' : a.absolute.label === 'CLOSE' ? 'close' : 'not yet'

function bestAgent(agents: readonly CompareAgent[]): CompareAgent | null {
  let best: CompareAgent | null = null
  for (const a of agents) if (a.mean_score !== null && (best === null || (best.mean_score ?? -Infinity) < a.mean_score)) best = a
  return best
}

/** The summary of one use case from its compare response and route rows (either may be missing). */
export function summarizeUseCase(compare: UseCaseCompareResponse | null, routes: readonly Route[] | null): UseCaseSummary {
  const agents = compare?.agents ?? []
  const best = bestAgent(agents)
  const rec = recommendAgent(agents)
  const shown = rec?.agent ?? null
  const live = routes ? latestLive(routes) : null
  return {
    bestScore: best?.mean_score ?? null,
    costPerTask: (shown ?? best)?.cost_per_task ?? null,
    verdict: compare ? (shown ? absoluteText(shown) : 'not yet') : null,
    relative: shown ? shown.relative.label : null,
    routeModel: live?.model_id ?? null,
    routeHarness: live?.harness ?? null,
    fallbackModel: live?.fallback_model_id ?? null,
    agents: agents.length,
  }
}

/** A score 0..100 as a whole number, or a dash. */
export const scoreText = (x: number | null) => (x === null ? '—' : String(Math.round(x)))

/** A cost per task in USD: two decimals from one cent up, three below. */
export function costText(x: number | null): string {
  if (x === null) return '—'
  if (x === 0) return '$0'
  return `$${x >= 0.01 ? x.toFixed(2) : x.toFixed(3)}`
}

export type VerdictFilter = 'all' | 'same' | 'close' | 'not yet'
export const VERDICT_FILTERS: readonly VerdictFilter[] = ['all', 'same', 'close', 'not yet']

/** True when a row passes the verdict filter. A row with no summary yet passes only "all". */
export const passesVerdict = (s: UseCaseSummary | undefined, f: VerdictFilter) => f === 'all' || s?.verdict === f

/** Two letters of a harness or a model name for the agent tile (canvas: "CC" on the Claude Code ground). */
export function agentLetters(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('claude')) return 'CC'
  if (n.includes('codex') || n.includes('gpt')) return 'CX'
  if (n.includes('opencode') || n.includes('glm') || n.includes('deepseek') || n.includes('qwen')) return 'OC'
  const parts = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ')
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase()
}

/** The avatar ground class of a name (theme tokens --stu-av-*). */
export function agentGround(name: string): 'cc' | 'cx' | 'oc' | 'al' {
  const l = agentLetters(name)
  return l === 'CC' ? 'cc' : l === 'CX' ? 'cx' : l === 'OC' ? 'oc' : 'al'
}
