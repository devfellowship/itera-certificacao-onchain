import { useCallback, useEffect, useState } from 'react'
import { api, getSessionToken } from '../../lib/api'
import type { Tag, Task } from '../../lib/api'

export interface TaskCatalog {
  tasks: Task[]
  counts: { all: number; public: number; mine: number }
  tools: Tag[]
  concepts: Tag[]
}

export type CatalogState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; catalog: TaskCatalog }

// One request pair per session token: the Task Filter and the page that shows "Ranked on" chips share it.
const cache = new Map<string, Promise<TaskCatalog>>()

async function loadCatalog(): Promise<TaskCatalog> {
  const [taskRes, tagRes] = await Promise.all([api.tasks({ source: 'all' }), api.tags().catch(() => null)])
  const { tasks, counts } = taskRes
  let tags: Tag[] | null = tagRes?.tags ?? null
  if (!tags) {
    // /tags is the source of the sidebar lists. Without it, derive them from the tasks.
    const seen = new Map<string, Tag>()
    for (const t of tasks) for (const g of t.tags) seen.set(g.id, g)
    tags = [...seen.values()]
  }
  return { tasks, counts, tools: tags.filter((g) => g.kind === 'tool'), concepts: tags.filter((g) => g.kind === 'concept') }
}

/** Loads GET /tasks (source=all) and GET /tags once per session. `reload` drops the cache. */
export function useTaskCatalog(): CatalogState & { reload: () => void } {
  const [state, setState] = useState<CatalogState>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    const key = getSessionToken() ?? 'anon'
    let p = cache.get(key)
    if (!p) {
      p = loadCatalog()
      cache.set(key, p)
      p.catch(() => cache.delete(key))
    }
    setState({ status: 'loading' })
    p.then(
      (catalog) => alive && setState({ status: 'ready', catalog }),
      (e: unknown) => alive && setState({ status: 'error', message: e instanceof Error ? e.message : 'Could not load tasks.' }),
    )
    return () => {
      alive = false
    }
  }, [nonce])

  const reload = useCallback(() => {
    cache.delete(getSessionToken() ?? 'anon')
    setNonce((n) => n + 1)
  }, [])
  return { ...state, reload }
}

/** A task is found by catalog id or by slug (URLs and the ranking API accept both). */
export function findTask(tasks: Task[], idOrSlug: string): Task | undefined {
  return tasks.find((t) => t.id === idOrSlug || t.slug === idOrSlug)
}
