/**
 * Lazy, cached reads of GET /public/evaluations/:slug for the task page. One promise per slug, at
 * most 4 requests in flight at a time. The chat view (top run) and the runs table (CI bands) share it.
 */
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { PublicEvaluation, RunAction } from '../../lib/api/types'

export const MAX_IN_FLIGHT = 4

const cache = new Map<string, Promise<PublicEvaluation | null>>()
let inFlight = 0
const queue: Array<() => void> = []

function next() {
  if (inFlight >= MAX_IN_FLIGHT) return
  const job = queue.shift()
  if (job) job()
}

/** Resolves to the evaluation, or null on any error (the page shows a bar without a band). */
export function fetchPublicEvaluation(slug: string): Promise<PublicEvaluation | null> {
  const hit = cache.get(slug)
  if (hit) return hit
  const p = new Promise<PublicEvaluation | null>((resolve) => {
    queue.push(() => {
      inFlight += 1
      api
        .publicEvaluation(slug)
        .then((e) => resolve(e))
        .catch(() => resolve(null))
        .finally(() => {
          inFlight -= 1
          next()
        })
    })
    next()
  })
  cache.set(slug, p)
  return p
}

/** Tests call this between cases. */
export function clearEvaluationCache() {
  cache.clear()
  queue.length = 0
  inFlight = 0
}

export type TaskChecks = { passed: number; total: number }

/** The entry of `taskSlug` in a public evaluation (by slug; by name when the API gave no slug). */
export function taskEntryOf(e: PublicEvaluation | null, taskSlug: string, taskName?: string): PublicEvaluation['tasks'][number] | null {
  if (!e) return null
  return e.tasks.find((t) => t.slug === taskSlug) ?? (taskName ? e.tasks.find((t) => !t.slug && t.name === taskName) : undefined) ?? null
}

/**
 * Checks passed / total of this task in each evaluation slug. `undefined` while loading, `null` when
 * the evaluation could not be read or does not hold this task.
 */
export function useEvaluationChecks(slugs: Array<string | null>, taskSlug: string, taskName?: string): Record<string, TaskChecks | null | undefined> {
  const [state, setState] = useState<Record<string, TaskChecks | null>>({})
  const key = slugs.filter(Boolean).join('|')
  useEffect(() => {
    let live = true
    for (const slug of slugs) {
      if (!slug) continue
      void fetchPublicEvaluation(slug).then((e) => {
        if (!live) return
        const t = taskEntryOf(e, taskSlug, taskName)
        setState((s) => ({ ...s, [slug]: t ? { passed: t.testsPassed, total: t.testsTotal } : null }))
      })
    }
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, taskSlug, taskName])
  return state
}

export type TopRun = { kind: 'loading' } | { kind: 'none' } | { kind: 'ok'; runId: string; actions: RunAction[]; hasMore: boolean }

/** The tool calls of the top public run: evaluation slug → this task's runId → first page of actions. */
export function useTopRunActions(evaluationSlug: string | null | undefined, taskSlug: string, taskName?: string): TopRun {
  const [state, setState] = useState<TopRun>(evaluationSlug ? { kind: 'loading' } : { kind: 'none' })
  useEffect(() => {
    if (!evaluationSlug) {
      setState({ kind: 'none' })
      return
    }
    let live = true
    setState({ kind: 'loading' })
    fetchPublicEvaluation(evaluationSlug)
      .then((e) => {
        const runId = taskEntryOf(e, taskSlug, taskName)?.runId
        if (!runId) return null
        return api.runActions(runId).then((r) => ({ runId, actions: r.actions, hasMore: r.hasMore }))
      })
      .then((r) => live && setState(r ? { kind: 'ok', ...r } : { kind: 'none' }))
      .catch(() => live && setState({ kind: 'none' }))
    return () => {
      live = false
    }
  }, [evaluationSlug, taskSlug, taskName])
  return state
}
