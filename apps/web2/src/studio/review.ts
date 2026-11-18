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
/**
 * The rubric of each judge as the reviewer reads it on the card: the "Pass when" and "Fail when" lines of
 * devfellowship/dfl-evals judges/<id>/0.1.0/rubric.md (commit da3972a, dfl-evals#17), word for word. A person label is
 * a verdict on THIS rubric, so the card must show it; a new judge version changes this text in the same PR.
 */
export interface JudgeRubric {
  version: string
  criterion: string
  pass: readonly string[]
  fail: readonly string[]
}
export const JUDGE_RUBRICS: Record<JudgeId, JudgeRubric> = {
  'async-wait-lifecycle': {
    version: '0.1.0',
    criterion:
      'Each wait on an outside process (CI, a deploy, a merge queue, a background subagent) uses a watcher that calls no model and an end of turn, then the run acts on the wake.',
    pass: [
      'The run starts a background watcher (a shell loop or a monitor that calls no model), ends its turn, and continues after the wake.',
      'Or the run has no outside wait at all.',
      'Or the run ends at a wait, and its final report names the wait, the watcher and who acts next.',
      'A short single status read (one check, no loop) before a decision is not polling.',
    ],
    fail: [
      'The run polls the outside process inside the session: repeated status reads, a foreground sleep, or an until loop that the session waits on.',
      'The run starts a watcher, but the wake never reaches the run, and the run ends without a report of the open wait.',
      'The run ends at the wait with no watcher and no report.',
      'Before 2026-10-16 (the no-polling rule), in-session polling fails only when the brief of the run forbids it.',
    ],
  },
  'external-block-handling': {
    version: '0.1.0',
    criterion:
      'When a state outside the run blocks a step (red CI on main, an overloaded shared machine, a broken production dependency), the run finds the outside cause from evidence, stops the dependent step, and reports the block with its evidence and a next owner.',
    pass: [
      'No outside state blocks any step of the run.',
      'Or the run names the outside cause with evidence (a log line, a status, a measurement), stops the dependent step, and its report gives the block and a next owner.',
      'A fix of the outside cause counts as a pass only when it is inside the scope of the brief of the run.',
    ],
    fail: [
      'The run retries the blocked step again and again with no new evidence.',
      'The run goes around the gate: it merges past a red check, skips the step, or moves the work to a machine or runner that a rule forbids.',
      'The run reports the blocked step as done, or its report does not name the block.',
      'The run blames its own change for an outside cause, or an outside cause for its own change, against the evidence.',
    ],
  },
}
/**
 * The closed reason codes of the API (grader_results.reason_code CHECK, migration 0024). They name the faults of a
 * different check ("the wrong SHA", "no check"), not the faults of these two judges, so S13 shows no reason chips and
 * sends reason_code null. A reason set per judge needs a new CHECK, which is a migration (a human merge).
 */
export type ReasonCode = 'wrong_sha' | 'no_check' | 'partial' | 'other'
/** The queue size that S13 asks for: the API maximum, so the count on the screen is the whole queue (the default is 50). */
export const QUEUE_LIMIT = 200
export const SPLIT_TEXT: Record<'train' | 'dev' | 'test', string> = { test: 'test split', dev: 'dev split', train: 'train split' }

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
  /** The calibration split of the run's task for this judge (the queue lists test first); null when unknown. */
  split?: 'train' | 'dev' | 'test' | null
}

export interface HumanLabel {
  id: string
  runId: string
  judgeId: string
  pass: boolean
  reasonCode: ReasonCode | null
  labeler: string | null
  gradedAt: string
  /** strong = a person label (counts for calibration); weak = a workflow label; null = an agent or unknown login. */
  strength?: 'strong' | 'weak' | null
}

/** GET /review-queue/progress: the person labels of the tenant for one judge, per split and verdict, and the T4 floor. */
export interface ReviewProgress {
  judge: string
  floor: number
  splits: Record<'test' | 'dev' | 'train' | 'unknown', { pass: number; fail: number }>
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

export const getReviewQueue = (judge: JudgeId, limit: number = QUEUE_LIMIT) =>
  request<{ judge: string; runs: ReviewRun[] }>('/review-queue', { query: { judge, limit: String(limit) } })
export const getProgress = (judge: JudgeId) => request<ReviewProgress>('/review-queue/progress', { query: { judge } })
/** "test split: 3 of 30 pass · 1 of 30 fail" — the count Tainan needs before C6-T4 can split. */
export const progressText = (p: ReviewProgress) => {
  const t = p.splits.test
  return `test split: ${Math.min(t.pass, p.floor)} of ${p.floor} pass · ${Math.min(t.fail, p.floor)} of ${p.floor} fail`
}
/** True when the test split holds the floor of both verdicts. */
export const floorMet = (p: ReviewProgress) => p.splits.test.pass >= p.floor && p.splits.test.fail >= p.floor
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
