/**
 * Pure helpers of the grader library screens S10, S10a, S11 and S11a (plan 20261112-tma-c5-studio-area-web2, C5-RD-S10-S11).
 * The canvas artboard "S10-S11 Grader library + judge calibration" groups the graders (code graders, AI judges) and says
 * per grader whether it "can decide" a score. The words below come from the data only: a code grader is proven when its
 * mutation proof caught every planted bug; an AI judge decides when TPR and TNR pass the 90 % bar on a clean split;
 * human labels are the reference the judges are measured against. No figure is made up: a missing field says so.
 */
import { JUDGE_BAR, passesBar, splitCheck } from './calibration'
import type { GraderVersionDetail, GraderVersionItem } from './graders'
import { JUDGES, JUDGE_TITLES, type JudgeId } from './review'

export type GroupKey = 'code' | 'judge' | 'human'

export const GROUPS: ReadonlyArray<{ key: GroupKey; title: string; note: string }> = [
  { key: 'code', title: 'Code graders', note: 'Tests and rules: the same input gives the same answer every time.' },
  { key: 'judge', title: 'AI judges', note: `A model grades against a rubric. It counts only when it agrees with human labels (TPR and TNR at least ${Math.round(JUDGE_BAR * 100)}%).` },
  { key: 'human', title: 'Human labels', note: 'Pass or fail labels from people and workflows. They are the reference the AI judges are measured against.' },
]

export const groupTitle = (k: GroupKey) => GROUPS.find((g) => g.key === k)!.title

/** The "type" column of the artboard. */
export const TYPE_TEXT: Record<GroupKey, string> = { code: 'code', judge: 'AI judge', human: 'human labels' }

export type DecideTone = 'ok' | 'warn' | 'muted'

/** The "can decide" cell and the trust box of the side panel. */
export interface Decide {
  tone: DecideTone
  /** The short cell text. */
  text: string
  /** The trust box title. */
  title: string
  /** One plain sentence under the title. */
  note: string
}

/** A judge id of the review queue that this label grader belongs to (`label-<judge>`), else null. */
export function labelJudgeOf(graderId: string): JudgeId | null {
  const m = /^label-(.+)$/.exec(graderId)
  return m && (JUDGES as readonly string[]).includes(m[1]!) ? (m[1] as JudgeId) : null
}

export function decideOf(kind: GroupKey, d: Pick<GraderVersionDetail, 'proof' | 'tpr' | 'tnr' | 'calibration'> | null, hasVersion = true): Decide {
  if (kind === 'human') return { tone: 'muted', text: 'reference', title: 'The reference', note: 'People and workflows wrote these labels. The AI judges are measured against them; they are not a grader of their own.' }
  if (kind === 'judge') {
    if (!hasVersion) return { tone: 'muted', text: 'no version yet', title: 'No version yet', note: 'No version of this judge is uploaded. It shows here after its first calibration result.' }
    if (!d || (d.tpr === null && d.tnr === null)) return { tone: 'muted', text: 'not measured', title: 'Not measured yet', note: 'This version has no calibration record. It shows next to scores but does not decide one.' }
    const clean = d.calibration ? splitCheck(d.calibration).clean : false
    if (passesBar(d) && clean) return { tone: 'ok', text: 'yes, calibrated', title: 'Agrees with people', note: `Checked against ${d.calibration!.nTest} human labels it had never seen.` }
    return { tone: 'warn', text: 'not yet', title: 'Not trusted yet', note: `It does not reach the ${Math.round(JUDGE_BAR * 100)}% bar on a clean test split. It shows next to scores but does not decide one.` }
  }
  const p = d?.proof ?? null
  if (!p || p.total === 0) return { tone: 'warn', text: 'no proof yet', title: 'No mutation proof yet', note: 'No planted-bug proof is recorded for this version.' }
  if (p.caught === p.total) return { tone: 'ok', text: 'yes', title: 'Safe to decide scores', note: `Proven: it turned red on every planted bug (${p.caught} of ${p.total}).` }
  return { tone: 'warn', text: 'not yet', title: 'Missed planted bugs', note: `It caught ${p.caught} of ${p.total} planted bugs. A grader we trust turns red on every one.` }
}

/** The "proven" column. */
export function provenText(kind: GroupKey, d: Pick<GraderVersionDetail, 'proof' | 'calibration'> | null): string {
  if (kind === 'human') return '—'
  if (kind === 'judge') return d?.calibration ? `vs ${d.calibration.nTest} labels` : 'no labels yet'
  return d?.proof && d.proof.total > 0 ? `${d.proof.caught} of ${d.proof.total} caught` : 'no proof yet'
}

/** One line of the library: a grader with its newest version (null for a known judge that has no version yet). */
export interface LibraryRow {
  key: string
  graderId: string
  kind: GroupKey
  /** Newest first. Empty for a known judge with no version. */
  versions: GraderVersionItem[]
}

export const newestOf = (r: LibraryRow): GraderVersionItem | null => r.versions[0] ?? null

const byNewest = (a: GraderVersionItem, b: GraderVersionItem) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)

/**
 * Groups the versions by grader id, newest version first. Every known judge of the review queue gets a row, also with
 * no version yet (the artboard lists the judge; its calibration starts empty).
 */
export function libraryRows(items: GraderVersionItem[]): LibraryRow[] {
  const by = new Map<string, LibraryRow>()
  for (const g of items) {
    const kind: GroupKey = g.kind
    const key = `${kind}:${g.graderId}`
    const row = by.get(key) ?? { key, graderId: g.graderId, kind, versions: [] }
    row.versions.push(g)
    by.set(key, row)
  }
  for (const j of JUDGES) if (!by.has(`judge:${j}`)) by.set(`judge:${j}`, { key: `judge:${j}`, graderId: j, kind: 'judge', versions: [] })
  const rows = [...by.values()]
  for (const r of rows) r.versions.sort(byNewest)
  return rows.sort((a, b) => a.graderId.localeCompare(b.graderId))
}

/** What the grader checks, in plain words, from the data: the version note, the judge title, else null. */
export function whatItChecks(graderId: string, note: string | null | undefined): string | null {
  if (note) return note
  if ((JUDGES as readonly string[]).includes(graderId)) return JUDGE_TITLES[graderId as JudgeId]
  const j = labelJudgeOf(graderId)
  if (j) return `Pass or fail labels for the ${j} judge: "${JUDGE_TITLES[j]}".`
  return null
}

/** A tolerant check: a detail call can come back as another shape (a proxy page, a test stub). */
export const isDetail = (v: unknown): v is GraderVersionDetail => !!v && typeof v === 'object' && 'graderId' in v && Array.isArray((v as { recentRuns?: unknown }).recentRuns)

/** "17 runs", "1 run". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
