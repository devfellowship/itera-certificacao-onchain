/**
 * S7 step alignment (plan 20261112-tma-c5-studio-area-web2, task C5-T7; parent gap G7).
 *
 * Aligns the structural trajectories (tma-trajectory/1) of two runs of one case: the base run and the
 * variant run. Pure function, no UI and no I/O, so S7 can render the rows and a test can pin them.
 *
 * The rule:
 *   1. Each step gets a key: (tool, target_kind, hash of target_redacted).
 *   2. The longest common subsequence (LCS) of the two key lists gives the `same` rows.
 *   3. Between two `same` rows, the steps left on each side are paired by a second LCS on the tool
 *      name only. A pair has the same tool and a different target: a `changed` row.
 *   4. Every step that is still unpaired is a `none` row: the step exists on one side only.
 *
 * The rows come out in run order on both sides. The hash keeps the redacted target out of the key; a
 * changed row says which part of the key differs (`target_kind`, `target`, or both).
 */
import type { TargetKind } from '@itera/contracts'

/** The step fields the alignment reads. A full TrajectoryStep fits. */
export interface AlignableStep {
  seq: number
  tool: string
  target_kind: TargetKind
  target_redacted: string | null
}

export type AlignmentLabel = 'same' | 'changed' | 'none'

/** One aligned step: the seq of the run step plus the parts of its key. */
export interface AlignedStep {
  seq: number
  tool: string
  target_kind: TargetKind
  target_hash: string
}

export interface AlignmentRow {
  label: AlignmentLabel
  /** The base step, or null for a `none` row that exists only in the variant. */
  base: AlignedStep | null
  /** The variant step, or null for a `none` row that exists only in the base. */
  variant: AlignedStep | null
  /** For a `changed` row: which parts of the key differ. Empty for the other labels. */
  diff: Array<'target_kind' | 'target'>
}

export interface StepAlignment {
  rows: AlignmentRow[]
  counts: Record<AlignmentLabel, number>
}

/** The most steps per side; equal to TRAJECTORY_MAX_STEPS of the contract. */
export const ALIGNMENT_MAX_STEPS = 2000

/**
 * A deterministic 53-bit hash (cyrb53) of the redacted target, as 14 hex digits. Synchronous, so the
 * alignment stays a pure function in the browser. Null (target_kind none) hashes as the empty string.
 */
export function targetHash(target: string | null): string {
  const s = target ?? ''
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return n.toString(16).padStart(14, '0')
}

function toAligned(s: AlignableStep): AlignedStep {
  return { seq: s.seq, tool: s.tool, target_kind: s.target_kind, target_hash: targetHash(s.target_redacted) }
}

function fullKey(s: AlignedStep): string {
  return `${s.tool}\u001f${s.target_kind}\u001f${s.target_hash}`
}

function toolKey(s: AlignedStep): string {
  return s.tool
}

type Op = { kind: 'pair'; a: number; b: number } | { kind: 'a'; a: number } | { kind: 'b'; b: number }

/**
 * LCS of two key lists, as an ordered list of operations: a matched pair, a step of `a` only, or a
 * step of `b` only. The table is filled from the end, so the walk goes forward in run order. On a tie
 * the walk takes the `a` step first, so the result is deterministic.
 */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'pair', a: i, b: j })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ kind: 'a', a: i })
      i++
    } else {
      ops.push({ kind: 'b', b: j })
      j++
    }
  }
  for (; i < n; i++) ops.push({ kind: 'a', a: i })
  for (; j < m; j++) ops.push({ kind: 'b', b: j })
  return ops
}

function changedParts(base: AlignedStep, variant: AlignedStep): Array<'target_kind' | 'target'> {
  const diff: Array<'target_kind' | 'target'> = []
  if (base.target_kind !== variant.target_kind) diff.push('target_kind')
  if (base.target_hash !== variant.target_hash) diff.push('target')
  return diff
}

/** Pair the unmatched steps of one gap by tool name: `changed` rows, and `none` rows for the rest. */
function alignGap(base: AlignedStep[], variant: AlignedStep[], rows: AlignmentRow[]): void {
  if (base.length === 0 && variant.length === 0) return
  for (const op of lcsOps(base.map(toolKey), variant.map(toolKey))) {
    if (op.kind === 'pair') {
      const b = base[op.a]
      const v = variant[op.b]
      rows.push({ label: 'changed', base: b, variant: v, diff: changedParts(b, v) })
    } else if (op.kind === 'a') {
      rows.push({ label: 'none', base: base[op.a], variant: null, diff: [] })
    } else {
      rows.push({ label: 'none', base: null, variant: variant[op.b], diff: [] })
    }
  }
}

/**
 * Align the steps of a base run and a variant run. The input lists must be in run order (seq 1..n),
 * as a validated tma-trajectory/1 holds them.
 */
export function alignSteps(baseSteps: ReadonlyArray<AlignableStep>, variantSteps: ReadonlyArray<AlignableStep>): StepAlignment {
  if (baseSteps.length > ALIGNMENT_MAX_STEPS || variantSteps.length > ALIGNMENT_MAX_STEPS) {
    throw new RangeError(`a trajectory holds at most ${ALIGNMENT_MAX_STEPS} steps`)
  }
  const base = baseSteps.map(toAligned)
  const variant = variantSteps.map(toAligned)
  const rows: AlignmentRow[] = []
  let gapBase: AlignedStep[] = []
  let gapVariant: AlignedStep[] = []
  for (const op of lcsOps(base.map(fullKey), variant.map(fullKey))) {
    if (op.kind === 'pair') {
      alignGap(gapBase, gapVariant, rows)
      gapBase = []
      gapVariant = []
      rows.push({ label: 'same', base: base[op.a], variant: variant[op.b], diff: [] })
    } else if (op.kind === 'a') {
      gapBase.push(base[op.a])
    } else {
      gapVariant.push(variant[op.b])
    }
  }
  alignGap(gapBase, gapVariant, rows)
  const counts: Record<AlignmentLabel, number> = { same: 0, changed: 0, none: 0 }
  for (const r of rows) counts[r.label]++
  return { rows, counts }
}
