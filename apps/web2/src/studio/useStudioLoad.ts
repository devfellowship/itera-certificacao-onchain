/** A small loader for the studio screens (C5-T3): loading, ok, or an error with its HTTP status (503 = not migrated). */
import { useEffect, useState } from 'react'
import { ApiError } from '../lib/api'

export type Loaded<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; status: number; message: string }

export function useStudioLoad<T>(load: (() => Promise<T>) | null, deps: unknown[]): Loaded<T> {
  const [v, setV] = useState<Loaded<T>>({ state: 'loading' })
  useEffect(() => {
    if (!load) return
    let live = true
    setV({ state: 'loading' })
    load().then(
      (data) => live && setV({ state: 'ok', data }),
      (e: unknown) => live && setV({ state: 'error', status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : 'Request failed.' }),
    )
    return () => {
      live = false
    }
  }, deps)
  return v
}

/** The empty-state text of a failed studio load. */
export function loadErrorText(status: number): string {
  if (status === 503) return 'Eval results are not available yet: the result store is not migrated on this server.'
  if (status === 404) return 'Not found. It does not exist, or it belongs to another account.'
  if (status === 401) return 'Your session ended. Sign in again.'
  return 'The studio could not load this data. Reload the page to try again.'
}
