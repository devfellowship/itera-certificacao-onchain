/**
 * Use case key of a test case (plan 20261112-tma-c5-studio-area-web2, T1; parent Q-T17 = A).
 * The key is the layer-1 pair "type/subtype" (for example "fix/prod-bug"), or a bare "type" when the
 * case has no subtype. It is the column eval_cases.use_case_key of migration 0023.
 */
export type StudioCase = { caseKey: string; useCaseKey: string; mode?: string }

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
