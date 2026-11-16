/**
 * Client of the S13 review queue (plan 20261112-tma-c6-judge-calibration, task T3, ADR-6). The one studio write: a
 * human label, POST /grader-results/human. Reads: GET /review-queue?judge= and GET /grader-results/human?run_id=.
 * The API sends ids, digests, the task summary of the case and the structural step kinds; no trace text.
 * The full trace stays on the host: a run links to S3 (`tma studio serve`) when its case pin is in the serve index.
 */
import { request } from '../lib/api'
import { fetchTraceList, TRACE_PAGE_SIZE, type TraceFetchOptions } from './traces'

export const JUDGES = ['async-wait-lifecycle', 'external-block-handling'] as const
export type JudgeId = (typeof JUDGES)[number]
export const JUDGE_TITLES: Record<JudgeId, string> = {
  'async-wait-lifecycle': 'Waits use a watcher, not polling in the session',
  'external-block-handling': 'An outside block is found, stopped and reported',
}
export const REASONS = [
  { code: 'wrong_sha', text: 'Checked the wrong SHA' },
  { code: 'no_check', text: 'No check' },
  { code: 'partial', text: 'Partial' },
  { code: 'other', text: 'Other' },
] as const
export type ReasonCode = (typeof REASONS)[number]['code']

export interface Verdict {
  pass: boolean
  labeler: string | null
  gradedAt: string
}

export interface ReviewRun {
  runId: string
  caseKey: string
  useCaseKey: string
  originPinSha256: string | null
  taskSummary: { before: string | null; expected: string | null } | null
  modelId: string | null
  status: string
  startedAt: string
  steps: Array<{ seq: number; kind: string | null; ok: boolean | null }>
  judge: Verdict | null
  workflow: Verdict | null
  mine: Verdict | null
  disagree: boolean
}

export interface HumanLabel {
  id: string
  runId: string
  judgeId: string
  pass: boolean
  reasonCode: ReasonCode | null
  labeler: string | null
  gradedAt: string
}

/** One redacted step (GET /review-queue/steps): the tool, a redacted target, the outcome and the timing. No arguments and no output. */
export interface StepDetail {
  seq: number
  tool: string
  target: string | null
  kind: string | null
  status: string | null
  errorClass: string | null
  durationMs: number | null
  startedMs: number | null
  turnOrigin: string | null
}

export const isJudge = (v: string | null): v is JudgeId => v !== null && (JUDGES as readonly string[]).includes(v)

export const getReviewQueue = (judge: JudgeId) => request<{ judge: string; runs: ReviewRun[] }>('/review-queue', { query: { judge } })
export const getRunSteps = (runId: string) => request<{ run_id: string; steps: StepDetail[] }>('/review-queue/steps', { query: { run_id: runId } })
export const getLabels = (runId: string) => request<{ labels: HumanLabel[] }>('/grader-results/human', { query: { run_id: runId } })
export const postLabel = (b: { run_id: string; judge_id: JudgeId; pass: boolean; reason_code: ReasonCode | null }) =>
  request<HumanLabel>('/grader-results/human', { method: 'POST', body: JSON.stringify(b) })

/** One letter per step kind, for the folded trajectory strip. */
const KIND_LETTER: Record<string, string> = { read: 'R', search: 'S', write: 'W', test: 'T', mcp: 'M', shell: '$', agent: 'A', other: 'O' }
export const kindLetter = (k: string | null) => (k && KIND_LETTER[k]) || '·'

/** Folds a long step list: the first `head` steps, a gap, and the last `tail` steps (the end of a run is where a wait is). */
export function foldSteps<T>(steps: readonly T[], head = 12, tail = 12): { head: T[]; hidden: number; tail: T[] } {
  if (steps.length <= head + tail) return { head: [...steps], hidden: 0, tail: [] }
  return { head: steps.slice(0, head), hidden: steps.length - head - tail, tail: steps.slice(-tail) }
}

/** pin_sha256 -> {session, agent} from the serve index (at most `maxPages` pages). Empty when the serve is absent. */
export async function pinIndex(opts: TraceFetchOptions = {}, maxPages = 10): Promise<Map<string, { sessionId: string; agentId: string | null }>> {
  const out = new Map<string, { sessionId: string; agentId: string | null }>()
  for (let page = 0; page < maxPages; page++) {
    const list = await fetchTraceList({ limit: TRACE_PAGE_SIZE, offset: page * TRACE_PAGE_SIZE }, opts)
    for (const r of list.rows) {
      const pin = r.pin?.pin_sha256
      if (pin && r.session_id && !out.has(pin)) out.set(pin, { sessionId: r.session_id, agentId: r.agent_id })
    }
    if (list.rows.length < TRACE_PAGE_SIZE) break
  }
  return out
}

/** 1.2 s, 45 s, 3 min 10 s, 1 h 5 min. null stays null. */
export function fmtDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

/** The idle time between the end of the previous step and the start of this one (ms), or null when either timing is missing. */
export function gapBefore(prev: StepDetail | undefined, cur: StepDetail): number | null {
  if (!prev || prev.startedMs === null || cur.startedMs === null) return null
  const end = prev.startedMs + (prev.durationMs ?? 0)
  return Math.max(0, cur.startedMs - end)
}

/** A gap of this size or more is shown as an idle stretch of the agent (a wait, or a pause between turns). */
export const LONG_GAP_MS = 30_000
