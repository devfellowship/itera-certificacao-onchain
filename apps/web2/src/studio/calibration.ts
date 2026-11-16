/**
 * Data of the judge calibration screens S11 and S11a (plan 20261112-tma-c6-judge-calibration, task T6). Read only.
 * No new API route: it reads GET /grader-versions (the list), GET /grader-versions/:id (tpr, tnr, counts, digests) and
 * GET /review-queue?judge= (the run and label counts). A judge version appears only after its calibration record is
 * uploaded (tma eval judge calibrate), so every figure has an empty state.
 * The calibration record holds counts only (n_labels, n_test, tp, fn, tn, fp). The interval is therefore a 95 % Wilson
 * interval computed from those counts (the bootstrap interval of the T5 report stays in the plan and in dfl-evals).
 */
import { getGraderVersion, listGraderVersions, type GraderVersionDetail, type GraderVersionItem } from './graders'
import { JUDGES, getReviewQueue, type JudgeId } from './review'

/** The bar of a decisive judge: TPR and TNR both at least 0.90 (parent ADR-21; the canvas said 85 %). */
export const JUDGE_BAR = 0.9
/** Test split floor: at least this many pass labels and this many fail labels (C6-T4). */
export const SPLIT_FLOOR = 30

/** A11 Q1 = B: the models a judge may use when it reads private trace text (catalog ids). Same list as the eval kit. */
export const ALLOWED_JUDGE_MODELS: readonly string[] = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'anthropic/claude-fable-5.2',
]
const LOCAL_ROUTE = /^(?:ollama|local)\/\S+$/

export const modelAllowed = (model: string): boolean => ALLOWED_JUDGE_MODELS.includes(model) || LOCAL_ROUTE.test(model)

/** The model name to show: a name outside the A11 Q1 = B list is never printed (canvas fix, parent ADR-35). */
export function shownModel(model: string | null): string {
  if (!model) return 'not recorded'
  return modelAllowed(model) ? model : 'a model outside the allowed list'
}

/** "93.3%" for 0.933; "n/a" for null. */
export const pct = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 1000) / 10}%`)

/** 95 % Wilson score interval of k successes in n trials; null when n is 0. */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (!(n > 0) || k < 0 || k > n) return null
  const p = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) }
}

export const intervalText = (i: { lo: number; hi: number } | null): string => (i ? `95% interval ${pct(i.lo)} to ${pct(i.hi)}` : 'no interval (no labels)')

export interface SplitCheck {
  /** Pass labels in the test split (tp + fn). */
  pass: number
  /** Fail labels in the test split (tn + fp). */
  fail: number
  clean: boolean
}

export function splitCheck(c: NonNullable<GraderVersionDetail['calibration']>): SplitCheck {
  const pass = c.tp + c.fn
  const fail = c.tn + c.fp
  return { pass, fail, clean: pass >= SPLIT_FLOOR && fail >= SPLIT_FLOOR }
}

/** True when both rates are known and at least the bar. */
export const passesBar = (v: Pick<GraderVersionDetail, 'tpr' | 'tnr'>): boolean => v.tpr !== null && v.tnr !== null && v.tpr >= JUDGE_BAR && v.tnr >= JUDGE_BAR

/** The review queue holds the runs that no person has labeled yet for the judge (S13), capped at QUEUE_LIMIT. */
export const QUEUE_LIMIT = 200

export interface QueueCounts {
  /** Runs still waiting for a human label. */
  toReview: number
  workflowLabels: number
  judgeVerdicts: number
}

export interface JudgeCalibration {
  judge: JudgeId
  /** Versions of this judge (grader kind judge, grader id = judge id), oldest first, with their detail. */
  versions: GraderVersionDetail[]
  /** Null when the review queue could not be read. */
  queue: QueueCounts | null
  /** Label rows written for this judge, from every source (weak workflow labels and people): the use count of grader `label-<judge>`. Null when none yet. */
  labelRows: number | null
}

export const isKnownJudge = (v: string): v is JudgeId => (JUDGES as readonly string[]).includes(v)

/** Versions of one judge, oldest first. */
export function versionsOf(items: GraderVersionItem[], judge: string): GraderVersionItem[] {
  return items.filter((g) => g.kind === 'judge' && g.graderId === judge).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
}

async function queueCounts(judge: JudgeId): Promise<QueueCounts | null> {
  try {
    const q = await getReviewQueue(judge, QUEUE_LIMIT)
    return {
      toReview: q.runs.length,
      workflowLabels: q.runs.filter((r) => r.workflow !== null).length,
      judgeVerdicts: q.runs.filter((r) => r.judge !== null).length,
    }
  } catch {
    return null
  }
}

async function loadOne(judge: JudgeId, all: GraderVersionItem[]): Promise<JudgeCalibration> {
  const [versions, queue] = await Promise.all([Promise.all(versionsOf(all, judge).map((v) => getGraderVersion(v.id))), queueCounts(judge)])
  const labels = all.filter((g) => g.kind === 'human' && g.graderId === `label-${judge}`)
  return { judge, versions, queue, labelRows: labels.length === 0 ? null : labels.reduce((n, g) => n + g.usedByCount, 0) }
}

/** S11: both judges. The version list is one call; a failed list (503, 404) throws and the page shows the empty state. */
export async function loadCalibration(): Promise<JudgeCalibration[]> {
  const { graderVersions } = await listGraderVersions()
  return Promise.all(JUDGES.map((judge) => loadOne(judge, graderVersions)))
}

/** S11a: one judge. */
export async function loadJudge(judge: JudgeId): Promise<JudgeCalibration> {
  const { graderVersions } = await listGraderVersions()
  return loadOne(judge, graderVersions)
}

/** The copy command of the calibration run (the studio never runs it). */
export function calibrateCommand(judge: string, semver: string | null, model: string | null): string {
  return `tma eval judge calibrate --judge ${judge} --version ${semver ?? '<semver>'} --model ${model && modelAllowed(model) ? model : '<model id>'}`
}
