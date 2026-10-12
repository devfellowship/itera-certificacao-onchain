/**
 * When does a task have a public details page `/tasks/:slug`? (lane U35, Tainan TG 21083)
 * The page is served by GET /public/tasks/:slug, which answers only for catalog tasks that are
 * public and ready (apps/api/src/public/task-store.pg.ts). Keep this predicate in step with that
 * query: when the API starts to serve public user tasks too, widen it here and every link follows.
 */
export interface TaskLinkFields {
  slug?: string | null
  kind?: string | null
  visibility?: string | null
  status?: string | null
}

export function hasPublicPage(t: TaskLinkFields): boolean {
  return !!t.slug && t.kind === 'itera' && t.visibility === 'public' && t.status === 'ready'
}

/** `/tasks/:slug` for a task with a public page, else null. */
export function publicTaskHref(t: TaskLinkFields): string | null {
  return hasPublicPage(t) ? `/tasks/${encodeURIComponent(t.slug!)}` : null
}

export interface TaskRef {
  id?: string | null
  slug?: string | null
}

/** Finds a task in a catalog list by id or by slug. */
export function lookupTask<T extends TaskLinkFields & { id: string }>(tasks: T[], ref: TaskRef): T | undefined {
  return tasks.find((t) => (ref.id && t.id === ref.id) || (ref.slug && t.slug === ref.slug))
}
