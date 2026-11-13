/**
 * Use case key of a test case (plan 20261112-tma-c5-studio-area-web2, T1; parent Q-T17 = A).
 * The key is the layer-1 pair "type/subtype" (for example "fix/prod-bug"), or a bare "type" when the
 * case has no subtype. It is the column eval_cases.use_case_key of migration 0023.
 */
export type StudioCase = { caseKey: string; useCaseKey: string; mode?: string; /** L2 cluster, shown as a tag. */ cluster?: string | null }

/**
 * The 33 L1 pairs of taxonomy v4 that hold an L2 cluster.
 * Source: dfl-harness skills/task-classify/taxonomy/v4.json. Decision: Q-T17 = A (parent ADR-29).
 */
export const L1_PAIRS_V4: readonly string[] = Object.freeze([
  'build/automation', 'build/feature', 'build/infra', 'build/mcp-tool', 'build/refactor', 'build/schema-migration',
  'build/service', 'build/skill', 'build/test', 'build/ui-component',
  'content/brief', 'content/campaign', 'content/doc-deck', 'content/lesson', 'content/media', 'content/report-html', 'content/ui-design',
  'fix/config', 'fix/prod-bug', 'fix/red-ci', 'fix/ui',
  'ops/admin', 'ops/cleanup', 'ops/data-repair', 'ops/deploy', 'ops/vps-config',
  'plan/epic', 'plan/questions', 'plan/write-plan',
  'research/measure-audit', 'research/prod-investigation',
  'verify/pr-review', 'verify/prod-verify',
])

/** True only for one of the 33 pairs. A bare type, or any other name, is not a pair. */
export function isL1Pair(key: string): boolean {
  return L1_PAIRS_V4.includes(key)
}

export type UseCaseGroup = {
  type: string
  /** Subgroups, in alphabetical order. A case with a bare type key goes in the subgroup with subtype null. */
  subtypes: Array<{ subtype: string | null; cases: StudioCase[] }>
  total: number
}

export function splitUseCaseKey(key: string): { type: string; subtype: string | null } {
  const i = key.indexOf('/')
  if (i < 0) return { type: key, subtype: null }
  return { type: key.slice(0, i), subtype: key.slice(i + 1) || null }
}

/** Group cases by the L1 pair: type first, then subtype. Both levels sort by name; a null subtype sorts first. */
export function groupByUseCase(cases: StudioCase[]): UseCaseGroup[] {
  const types = new Map<string, Map<string | null, StudioCase[]>>()
  for (const c of cases) {
    const { type, subtype } = splitUseCaseKey(c.useCaseKey)
    const subs = types.get(type) ?? new Map<string | null, StudioCase[]>()
    subs.set(subtype, [...(subs.get(subtype) ?? []), c])
    types.set(type, subs)
  }
  return [...types.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, subs]) => ({
      type,
      total: [...subs.values()].reduce((n, l) => n + l.length, 0),
      subtypes: [...subs.entries()]
        .sort(([a], [b]) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
        .map(([subtype, list]) => ({ subtype, cases: [...list].sort((x, y) => x.caseKey.localeCompare(y.caseKey)) })),
    }))
}
