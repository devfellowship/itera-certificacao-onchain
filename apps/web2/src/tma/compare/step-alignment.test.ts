import { describe, expect, it } from 'vitest'
import type { TargetKind } from '@itera/contracts'
import { ALIGNMENT_MAX_STEPS, alignSteps, targetHash, type AlignableStep } from './step-alignment'

/** Steps from short specs: "Tool kind:target" or "Tool" (target_kind none). seq is 1..n. */
function steps(...specs: string[]): AlignableStep[] {
  return specs.map((spec, i) => {
    const [tool, rest] = spec.split(' ')
    if (rest === undefined) return { seq: i + 1, tool, target_kind: 'none', target_redacted: null }
    const at = rest.indexOf(':')
    return { seq: i + 1, tool, target_kind: rest.slice(0, at) as TargetKind, target_redacted: rest.slice(at + 1) }
  })
}

/** The rows as "label base-seq/variant-seq", so a fixture reads as one line. */
function shape(base: AlignableStep[], variant: AlignableStep[]): string[] {
  return alignSteps(base, variant).rows.map((r) => `${r.label} ${r.base?.seq ?? '-'}/${r.variant?.seq ?? '-'}`)
}

const RUN = steps('Read file:src/a.ts', 'Grep pattern:handler', 'Edit file:src/a.ts', 'Bash command:npm test', 'TodoWrite')

describe('alignSteps (S7, C5-T7)', () => {
  it('equal: identical lists give only same rows', () => {
    const a = alignSteps(RUN, RUN)
    expect(a.counts).toEqual({ same: 5, changed: 0, none: 0 })
    expect(shape(RUN, RUN)).toEqual(['same 1/1', 'same 2/2', 'same 3/3', 'same 4/4', 'same 5/5'])
  })

  it('insertion: one step added in the variant gives one none row on the variant side', () => {
    const variant = steps('Read file:src/a.ts', 'Grep pattern:handler', 'Read file:src/b.ts', 'Edit file:src/a.ts', 'Bash command:npm test', 'TodoWrite')
    const a = alignSteps(RUN, variant)
    expect(a.counts).toEqual({ same: 5, changed: 0, none: 1 })
    expect(shape(RUN, variant)).toEqual(['same 1/1', 'same 2/2', 'none -/3', 'same 3/4', 'same 4/5', 'same 5/6'])
  })

  it('deletion: one step missing in the variant gives one none row on the base side', () => {
    const variant = steps('Read file:src/a.ts', 'Edit file:src/a.ts', 'Bash command:npm test', 'TodoWrite')
    const a = alignSteps(RUN, variant)
    expect(a.counts).toEqual({ same: 4, changed: 0, none: 1 })
    expect(shape(RUN, variant)).toEqual(['same 1/1', 'none 2/-', 'same 3/2', 'same 4/3', 'same 5/4'])
  })

  it('substitution of the target: same tool, other target gives one changed row', () => {
    const variant = steps('Read file:src/a.ts', 'Grep pattern:webhook', 'Edit file:src/a.ts', 'Bash command:npm test', 'TodoWrite')
    const a = alignSteps(RUN, variant)
    expect(a.counts).toEqual({ same: 4, changed: 1, none: 0 })
    const changed = a.rows.filter((r) => r.label === 'changed')
    expect(changed).toHaveLength(1)
    expect(changed[0].base?.seq).toBe(2)
    expect(changed[0].variant?.seq).toBe(2)
    expect(changed[0].diff).toEqual(['target'])
  })

  it('substitution of the target kind is a changed row that names both parts', () => {
    const variant = steps('Read file:src/a.ts', 'Grep dir:handler', 'Edit file:src/a.ts', 'Bash command:npm test', 'TodoWrite')
    const changed = alignSteps(RUN, variant).rows.filter((r) => r.label === 'changed')
    expect(changed.map((r) => r.diff)).toEqual([['target_kind']])
    const both = steps('Read file:src/a.ts', 'Grep dir:src', 'Edit file:src/a.ts', 'Bash command:npm test', 'TodoWrite')
    expect(alignSteps(RUN, both).rows.filter((r) => r.label === 'changed').map((r) => r.diff)).toEqual([['target_kind', 'target']])
  })

  it('substitution of the tool: no pair, so one none row per side', () => {
    const variant = steps('Read file:src/a.ts', 'Glob pattern:handler', 'Edit file:src/a.ts', 'Bash command:npm test', 'TodoWrite')
    const a = alignSteps(RUN, variant)
    expect(a.counts).toEqual({ same: 4, changed: 0, none: 2 })
    expect(shape(RUN, variant)).toEqual(['same 1/1', 'none 2/-', 'none -/2', 'same 3/3', 'same 4/4', 'same 5/5'])
  })

  it('keeps run order on both sides and covers every step exactly once', () => {
    const variant = steps('Bash command:git status', 'Read file:src/a.ts', 'Edit file:src/b.ts', 'Bash command:npm test', 'Bash command:npm test', 'Read file:x')
    const a = alignSteps(RUN, variant)
    const baseSeqs = a.rows.flatMap((r) => (r.base ? [r.base.seq] : []))
    const variantSeqs = a.rows.flatMap((r) => (r.variant ? [r.variant.seq] : []))
    expect(baseSeqs).toEqual([1, 2, 3, 4, 5])
    expect(variantSeqs).toEqual([1, 2, 3, 4, 5, 6])
    expect(a.counts.same + a.counts.changed + a.counts.none).toBe(a.rows.length)
  })

  it('handles empty runs', () => {
    expect(alignSteps([], []).rows).toEqual([])
    expect(alignSteps(RUN, []).counts).toEqual({ same: 0, changed: 0, none: 5 })
    expect(alignSteps([], RUN).counts).toEqual({ same: 0, changed: 0, none: 5 })
  })

  it('keys on a hash, not on the target text', () => {
    expect(targetHash('src/a.ts')).toMatch(/^[0-9a-f]{14}$/)
    expect(targetHash('src/a.ts')).toBe(targetHash('src/a.ts'))
    expect(targetHash('src/a.ts')).not.toBe(targetHash('src/b.ts'))
    expect(targetHash(null)).toBe(targetHash(''))
    const row = alignSteps(RUN, RUN).rows[0]
    expect(row.base).toEqual({ seq: 1, tool: 'Read', target_kind: 'file', target_hash: targetHash('src/a.ts') })
    expect(JSON.stringify(row)).not.toContain('src/a.ts')
  })

  it('refuses more steps than a trajectory may hold', () => {
    const big = Array.from({ length: ALIGNMENT_MAX_STEPS + 1 }, (_, i) => ({ seq: i + 1, tool: 'Read', target_kind: 'none' as const, target_redacted: null }))
    expect(() => alignSteps(big, RUN)).toThrow(RangeError)
  })

  it('aligns two runs of the maximum size', () => {
    const big = Array.from({ length: ALIGNMENT_MAX_STEPS }, (_, i) => ({ seq: i + 1, tool: i % 2 ? 'Read' : 'Edit', target_kind: 'file' as const, target_redacted: `f${i % 7}` }))
    expect(alignSteps(big, big).counts).toEqual({ same: ALIGNMENT_MAX_STEPS, changed: 0, none: 0 })
  })
})
