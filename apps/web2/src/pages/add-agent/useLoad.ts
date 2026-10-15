import { useCallback, useEffect, useRef, useState } from 'react'

export interface Load<T> {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: T | null
  error: unknown
  /** Fetch again; the previous data stays until the new answer arrives (no flicker on focus refresh). */
  reload: () => void
}

/**
 * Runs `fn` when `deps` change (or `enabled` turns true) and keeps the latest answer.
 * An answer that arrives after a newer call started is dropped, so a fast branch switch never
 * shows the commits of the branch before it.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[], enabled = true): Load<T> {
  const [state, setState] = useState<Omit<Load<T>, 'reload'>>({ status: enabled ? 'loading' : 'idle', data: null, error: null })
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const run = useCallback((keep: boolean) => {
    const my = ++seq.current
    setState((s) => ({ status: 'loading', data: keep ? s.data : null, error: null }))
    fnRef.current().then(
      (data) => {
        if (my === seq.current) setState({ status: 'ready', data, error: null })
      },
      (error: unknown) => {
        if (my === seq.current) setState((s) => ({ status: 'error', data: keep ? s.data : null, error }))
      },
    )
  }, [])

  useEffect(() => {
    if (!enabled) {
      seq.current++
      setState({ status: 'idle', data: null, error: null })
      return
    }
    run(false)
    return () => {
      seq.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])

  const reload = useCallback(() => run(true), [run])
  return { ...state, reload }
}
