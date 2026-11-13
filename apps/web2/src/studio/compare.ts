/**
 * Types, call and pure view helpers of studio S8, the agent compare per use case (plan
 * 20261112-tma-c7-model-comparison-per-use-case, task C7-T4). Data: GET /use-cases/:key/compare (C7-T3).
 * Every rule (run score, the absolute and relative verdicts, the Pareto front, "dominated") runs once, in
 * packages/contracts/compare.js on the API (ADR-7). This module only formats what the response sends: it never
 * computes a verdict, a score, a front or a dominated flag.
 */
import type { AbsoluteLabel, RelativeLabel } from '@itera/contracts/compare'
import { request } from '../lib/api'

export interface CompareDistribution {
  min: number
  p10: number
  p50: number
  p90: number
  max: number
}

/** One agent of the use case (CompareAgentView of apps/api/src/self-declared/use-case-compare.ts). */
export interface CompareAgent {
  agent_key: string
  variant_ids: string[]
  model_id: string
  harness: string
  n: number
  infra_error_count: number
  no_score_runs: number
  hard_gate_failures: number
  mean_score: number | null
  distribution: CompareDistribution | null
  cost_per_task: number | null
  cost_label: 'metered' | 'derived' | null
  median_wall_ms: number | null
  /**
   * The counted run ids of this agent (sorted; at most 500): the exact list POST /routes/approve freezes for it (plan
   * C8, Q4 = A). Absent when an older API answers.
   */
  evidence_run_ids?: string[]
  /** The full number of counted runs; larger than evidence_run_ids.length when the API cut the list. */
  evidence_run_count?: number
  absolute: { label: AbsoluteLabel; reason: 'n_below_minimum' | null; runs_at_least_same: number; runs_at_least_close: number }
  relative: {
    label: RelativeLabel
    reason: 'n_below_minimum' | 'gap_below_margin' | 'not_significant' | 'is_current_agent' | 'no_current_agent' | null
    gap: number | null
    mann_whitney: { u: number; p: number; method: 'exact' | 'normal' } | null
  }
  pareto: { ineligible_reason: null | 'hard_gate_failure' | 'no_cost' | 'no_runs'; on_front: boolean | null; dominated: boolean | null }
}

/** The response body (UseCaseCompareView). `source` and `weights` are open strings: a later profile may add values. */
export interface UseCaseCompareResponse {
  use_case: string
  profile: {
    source: string
    sha256: string | null
    weights: string
    min_runs_per_cell: number
    relative_margin_points: number
    relative_alpha: number
    relative_test: string
    absolute_bars: { same: number; close: number }
  }
  rule_text: { absolute: string; relative: string }
  current_agent: string | null
  agents: CompareAgent[]
}

/** GET /use-cases/:key/compare. The `/` of the pair is encoded (%2F): the API takes the pair as one path segment. */
export const getUseCaseCompare = (useCase: string, currentAgent?: string | null) =>
  request<UseCaseCompareResponse>(`/use-cases/${encodeURIComponent(useCase)}/compare`, { query: { current_agent: currentAgent || null } })

const trim = (x: number, digits: number) => String(Number(x.toFixed(digits)))

/** A score 0..100 as the API rounded it (2 decimals at most), or a dash. */
export const formatScore = (x: number | null | undefined): string => (x === null || x === undefined ? '—' : trim(x, 2))

/** A cost per task in USD with its label. No cost: "no cost". A number with no label is shown as derived (never metered). */
export function formatCost(cost: number | null, label: CompareAgent['cost_label']): { amount: string; label: string } {
  if (cost === null) return { amount: 'no cost', label: '' }
  const amount = cost >= 1 ? `$${cost.toFixed(2)}` : `$${trim(cost, 6)}`
  return { amount, label: label ?? 'derived' }
}

/** A median wall time: ms under 1 s, seconds under 1 min, then minutes and seconds. */
export function formatWall(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${trim(ms / 1000, 1)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m} min ${s} s`
}

/** The signed gap in points (relative verdict), or a dash. */
export const formatGap = (gap: number | null): string => (gap === null ? '—' : `${gap > 0 ? '+' : ''}${trim(gap, 2)} pts`)

/** The text of an absolute label. `refused` is "not enough runs"; SAME / CLOSE / NOT YET are shown as sent. */
export function absoluteText(a: CompareAgent['absolute']): string {
  if (a.label === 'refused') return a.reason === 'n_below_minimum' ? 'not enough runs' : 'no verdict'
  return a.label
}

/** The text of a relative label: `tie` is the "same" of the plan, `refused` names its reason. */
export function relativeText(r: CompareAgent['relative']): string {
  if (r.label === 'tie') return 'same'
  if (r.label !== 'refused') return r.label
  if (r.reason === 'n_below_minimum') return 'not enough runs'
  if (r.reason === 'is_current_agent') return 'current agent'
  if (r.reason === 'no_current_agent') return 'no current agent'
  return 'no verdict'
}

/** Why the relative rule gave its label (only the reasons that the label text does not already say). */
export function relativeReasonText(r: CompareAgent['relative']): string | null {
  if (r.reason === 'gap_below_margin') return 'gap below the margin'
  if (r.reason === 'not_significant') return 'not significant'
  return null
}

const INELIGIBLE_TEXT: Record<NonNullable<CompareAgent['pareto']['ineligible_reason']>, string> = {
  hard_gate_failure: 'hard-gate failure',
  no_cost: 'no cost',
  no_runs: 'no runs',
}

/**
 * Why an agent is not a point of the Pareto chart, or null when it is one. The chart shows the cells the API marks
 * eligible (ineligible_reason null) that hold a full cell (n >= min_runs_per_cell) and a cost: the flags themselves
 * come from the response.
 */
export function notPlottedReason(a: CompareAgent, minRuns: number): string | null {
  if (a.pareto.ineligible_reason) return INELIGIBLE_TEXT[a.pareto.ineligible_reason] ?? a.pareto.ineligible_reason
  if (a.cost_per_task === null) return 'no cost'
  if (a.mean_score === null) return 'no score'
  if (a.n < minRuns) return `not enough runs (n ${a.n} of ${minRuns})`
  return null
}

/** The Pareto column text, from the response flags. */
export function paretoText(a: CompareAgent, minRuns: number): string {
  if (a.pareto.ineligible_reason) return INELIGIBLE_TEXT[a.pareto.ineligible_reason] ?? a.pareto.ineligible_reason
  if (a.n < minRuns) return 'not enough runs'
  if (a.pareto.on_front) return 'on front'
  if (a.pareto.dominated) return 'dominated'
  return '—'
}

/** Table order: mean score high to low (no score last), then the agent key. A display order only, not a rank. */
export function sortAgents(agents: readonly CompareAgent[]): CompareAgent[] {
  return [...agents].sort((a, b) => {
    const sa = a.mean_score ?? -Infinity
    const sb = b.mean_score ?? -Infinity
    return sb - sa || (a.agent_key < b.agent_key ? -1 : a.agent_key > b.agent_key ? 1 : 0)
  })
}

/** The lab prefix of a model id (`anthropic/claude-x` → `anthropic`), or null for a bare id. */
export function providerOf(modelId: string): string | null {
  const i = modelId.indexOf('/')
  return i > 0 ? modelId.slice(0, i) : null
}

/** The first 12 characters of a sha256, for display. */
export const sha12 = (sha: string) => sha.slice(0, 12)
