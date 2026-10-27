/**
 * Pure helpers of the evaluation review layout (L14b; owner's design, TG 23999 + 24004). No I/O, no React.
 * The rows of "Expected vs agent" come from GET /runs/:id (owner view) + GET /public/tasks/:slug. A row
 * that the data cannot fill is omitted, never faked. Score version 2 (ADR-5): the hidden part is the
 * whole score (100 points); every other row is a gate (a broken gate zeroes the score) or a diagnostic.
 */
import type { EvaluationDetail, Run, TaskProfile } from '../../lib/api'
import { fmtScore, round1 } from '../../tma/detail'

export type Verdict = 'correct' | 'close' | 'wrong' | 'missing'
export const VERDICT_MARK: Record<Verdict, string> = { correct: '✓', close: '≈', wrong: '●', missing: '–' }

export interface CompareRow {
  field: string
  expected: string
  agent: string
  verdict: Verdict
  /** `80/100`, or `—` when the row pays no points (score v2: a diagnostic). */
  points: string
  /** Points this row cost, for "Most points lost on {row}". */
  lost: number
}

export type Source = 'self-declared' | 'imported' | 'run here'

/** Detail fields that lib/api/types.ts does not declare yet; GET /evaluations/:id serves them (rollup.ts). */
export type ReviewDetail = Omit<EvaluationDetail, 'status' | 'uiState'> & { status: string; uiState: string; paymentKind?: string; resultOrigin?: string }
export type ReviewTask = EvaluationDetail['tasks'][number]

/** self-declared (resultOrigin) · imported (historical event) · else run here. */
export function sourceOf(d: Pick<ReviewDetail, 'resultOrigin' | 'paymentKind' | 'events'>): Source {
  if (d.resultOrigin === 'self_declared' || d.paymentKind === 'none') return 'self-declared'
  if (d.events.some((e) => e.label === 'Historical evaluation imported')) return 'imported'
  return 'run here'
}

/** Pass / Fail / Invalid of the whole evaluation: any FAIL fails it; all PASS passes it; else invalid. */
export function verdictOf(counts: { pass?: number; fail?: number; invalid?: number } | null | undefined): 'pass' | 'fail' | 'invalid' | null {
  if (!counts) return null
  if ((counts.fail ?? 0) > 0) return 'fail'
  if ((counts.pass ?? 0) > 0) return 'pass'
  if ((counts.invalid ?? 0) > 0) return 'invalid'
  return null
}

export type Gates = Record<string, boolean | null>

/** `score.rule.gates` of the run record (score v2), or an empty object. */
export function gatesOf(run: Run | null | undefined): Gates {
  const rule = run?.score?.rule as { gates?: unknown } | null | undefined
  const g = rule?.gates
  if (!g || typeof g !== 'object') return {}
  const out: Gates = {}
  for (const [k, v] of Object.entries(g as Record<string, unknown>)) out[k] = v === true ? true : v === false ? false : null
  return out
}

/** `diff --git` headers, `+` and `-` lines of a unified diff (headers `+++`/`---` excluded). */
export function patchStats(patch: string | null | undefined, changedFiles: string[] = []): { files: number; added: number; removed: number } {
  let files = changedFiles.length
  let added = 0
  let removed = 0
  let headers = 0
  for (const line of (patch ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) headers++
    else if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  if (!files) files = headers
  return { files, added, removed }
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export const PUBLIC_COLLAPSE_AFTER = 10

export interface RowsInput {
  run: Run | null | undefined
  /** `tasks[].score` of the evaluation (the run's score); falls back to `run.scoreTotal`. */
  taskScore: number | null | undefined
  durationMs: number | null | undefined
  profile: TaskProfile | null | undefined
  showAllPublic?: boolean
}

type PublicCase = { name: string; file?: string; passed: boolean }
type Suite = { passed: number; total: number; failed?: number; cases?: PublicCase[] }

function suiteVerdict(s: { passed: number; total: number }): Verdict {
  if (s.total <= 0) return 'missing'
  if (s.passed >= s.total) return 'correct'
  return s.passed > 0 ? 'close' : 'wrong'
}

/**
 * The rows of the Expected-vs-agent table for one run. `publicCollapsed` is the number of public
 * cases folded into one summary row (0 when every case has its own row).
 */
export function compareRows(i: RowsInput): { rows: CompareRow[]; publicCollapsed: number } {
  const rows: CompareRow[] = []
  const run = i.run
  if (!run) return { rows, publicCollapsed: 0 }
  const hp = i.profile?.scoring?.parts?.find((p) => p.key === 'hidden_behavior')?.points ?? 100
  const score = i.taskScore ?? run.scoreTotal ?? null
  const gates = gatesOf(run)

  // 1. hidden checks — the score itself (v2).
  const hidden = run.tests?.hidden
  if (hidden && hidden.total > 0) {
    rows.push({
      field: 'hidden checks',
      expected: `${hidden.total}/${hidden.total} pass`,
      agent: `${hidden.passed}/${hidden.total}`,
      verdict: suiteVerdict(hidden),
      points: `${fmtScore(score ?? 0)}/${hp}`,
      lost: round1(hp * (1 - Math.min(hidden.passed, hidden.total) / hidden.total)),
    })
  } else {
    rows.push({ field: 'hidden checks', expected: 'every check passes', agent: 'not graded', verdict: 'missing', points: score != null ? `${fmtScore(score)}/${hp}` : '—', lost: score != null ? round1(Math.max(0, hp - score)) : 0 })
  }

  // 2. public test cases — diagnostic, no points in v2.
  const pub = run.tests?.public as Suite | undefined
  let publicCollapsed = 0
  if (pub && Array.isArray(pub.cases) && pub.cases.length > 0) {
    if (pub.cases.length > PUBLIC_COLLAPSE_AFTER && !i.showAllPublic) {
      publicCollapsed = pub.cases.length
      rows.push({ field: 'public tests', expected: `${pub.total}/${pub.total} pass`, agent: `${pub.passed}/${pub.total}`, verdict: suiteVerdict(pub), points: '—', lost: 0 })
    } else {
      for (const c of pub.cases) rows.push({ field: `public: ${c.name}`, expected: 'pass', agent: c.passed ? 'pass' : 'fail', verdict: c.passed ? 'correct' : 'wrong', points: '—', lost: 0 })
    }
  } else if (pub && pub.total > 0) {
    rows.push({ field: 'public tests', expected: `${pub.total}/${pub.total} pass`, agent: `${pub.passed}/${pub.total}`, verdict: suiteVerdict(pub), points: '—', lost: 0 })
  }

  // 3. no regression against the public baseline.
  const base = run.tests?.publicBaseline
  if (pub && base) {
    rows.push({ field: 'no regression', expected: `≥ ${base.passed} public pass (baseline)`, agent: `${pub.passed} after the patch`, verdict: pub.passed >= base.passed ? 'correct' : 'wrong', points: '—', lost: 0 })
  }

  // 4. patch scope — a gate.
  const scope = run.patchScope
  if (scope || gates.patch_scope != null) {
    const allowed = scope ? scope.allowed : gates.patch_scope === true
    const paths = i.profile?.input?.editablePaths ?? []
    rows.push({ field: 'patch scope', expected: paths.length ? `only ${paths.join(', ')}` : 'inside the editable paths', agent: allowed ? 'inside scope' : 'outside scope', verdict: allowed ? 'correct' : 'wrong', points: allowed ? '—' : `0/${hp}`, lost: allowed ? 0 : hp })
  }

  // 5. patch — a gate.
  const stats = patchStats(run.patch, scope?.changedFiles ?? [])
  if (scope || run.patch || gates.patch_nonempty != null) {
    const nonEmpty = gates.patch_nonempty ?? stats.files > 0
    rows.push({ field: 'patch', expected: 'not empty', agent: stats.files > 0 ? `${stats.files} file${stats.files === 1 ? '' : 's'} changed` : nonEmpty ? 'not empty' : 'empty', verdict: nonEmpty ? 'correct' : 'wrong', points: nonEmpty ? '—' : `0/${hp}`, lost: nonEmpty ? 0 : hp })
  }

  // 6. time and cost against the task limits (needs the task profile).
  const limits = i.profile?.limits
  if (limits && limits.runTimeoutSec != null && i.durationMs != null) {
    const ok = i.durationMs / 1000 <= limits.runTimeoutSec
    rows.push({ field: 'time', expected: `≤ ${limits.runTimeoutSec}s`, agent: fmtDuration(i.durationMs), verdict: ok ? 'correct' : 'wrong', points: '—', lost: 0 })
  }
  if (limits && limits.costCapUsd != null) {
    const cost = run.modelCostUsd
    rows.push({ field: 'cost', expected: `≤ US$${limits.costCapUsd}`, agent: cost != null ? `US$${cost.toFixed(3)}` : 'not measured', verdict: cost == null ? 'missing' : cost <= limits.costCapUsd ? 'correct' : 'wrong', points: '—', lost: 0 })
  }

  // 7. the other gates of score.rule (patch_scope and patch_nonempty are rows 4 and 5).
  for (const [k, v] of Object.entries(gates)) {
    if (k === 'patch_scope' || k === 'patch_nonempty') continue
    rows.push({ field: `gate · ${k}`, expected: 'holds', agent: v === true ? 'holds' : v === false ? 'broken' : 'not applicable', verdict: v === true ? 'correct' : v === false ? 'wrong' : 'missing', points: v === false ? `0/${hp}` : '—', lost: v === false ? hp : 0 })
  }

  return { rows, publicCollapsed }
}

/** The field of the row with the most lost points, or null when no row lost any. */
export function mostLost(rows: CompareRow[]): CompareRow | null {
  let best: CompareRow | null = null
  for (const r of rows) if (r.lost > 0 && (!best || r.lost > best.lost)) best = r
  return best
}

export type NavTone = 'pass' | 'fail' | 'none'

export interface NavItem {
  seq: number
  runId: string
  name: string
  slug: string
  tone: NavTone
  score: number | null
}

/** One square per task run, in `seq` order. green = PASS, red = FAIL, grey = INVALID / not graded. */
export function navItemsOf(tasks: ReviewTask[]): NavItem[] {
  return [...tasks]
    .map((t, i) => ({ t, seq: t.seq ?? i + 1 }))
    .sort((a, b) => a.seq - b.seq)
    .map(({ t, seq }) => ({ seq, runId: t.runId, name: t.name, slug: t.slug, tone: t.outcome === 'PASS' ? 'pass' : t.outcome === 'FAIL' ? 'fail' : 'none', score: t.score }))
}

/** `{task names} · {source} · score v{n} · {shortId}`. */
export function subtitleOf(d: Pick<ReviewDetail, 'tasks' | 'shortId' | 'resultOrigin' | 'paymentKind' | 'events'>, run: Run | null | undefined): string {
  const names = d.tasks.map((t) => t.name)
  const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ')
  const version = run?.score?.version
  const shortId = d.shortId.startsWith('ev_') ? d.shortId : `ev_${d.shortId}`
  return [shown || null, sourceOf(d), version != null ? `score v${version}` : null, shortId].filter(Boolean).join(' · ')
}

/** The instruction inline when ≤ 600 characters; else its first line and a link to the full input. */
export const INLINE_INPUT_MAX = 600
export function inputPreview(text: string | null | undefined): { text: string; truncated: boolean } | null {
  if (!text) return null
  if (text.length <= INLINE_INPUT_MAX) return { text, truncated: false }
  const first = text.split('\n').find((l) => l.trim().length > 0) ?? text
  return { text: first.length > INLINE_INPUT_MAX ? `${first.slice(0, INLINE_INPUT_MAX)}…` : first, truncated: true }
}
