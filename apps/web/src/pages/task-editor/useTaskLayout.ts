import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import type { TaskLayoutResponse, TaskSourceInput } from '../../lib/api'
import { describeError } from '../add-agent/errors'

export type LayoutCheck =
  | { phase: 'idle' }
  | { phase: 'running' }
  /** The API read the pin. `data.layout.ok` false = no task.json, schema error or missing entries. */
  | { phase: 'done'; data: TaskLayoutResponse }
  | { phase: 'error'; message: string }

/**
 * Dry run of a task source (POST /tasks/layout, U19): pins branch + commit, reads task.json at the
 * commit and checks the folder layout. Nothing is stored. Debounced; a late answer for an older
 * input is dropped.
 */
export function useTaskLayout(input: TaskSourceInput | null): { check: LayoutCheck; retry: () => void } {
  const [check, setCheck] = useState<LayoutCheck>({ phase: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const seq = useRef(0)
  const key = input ? JSON.stringify([input.repoFullName, input.branch ?? '', input.commitSha ?? '', input.path ?? '.']) : null

  useEffect(() => {
    const my = ++seq.current
    if (!input || !key) {
      setCheck({ phase: 'idle' })
      return
    }
    setCheck({ phase: 'running' })
    const t = window.setTimeout(() => {
      api.taskLayout(input).then(
        (data) => my === seq.current && setCheck({ phase: 'done', data }),
        (e: unknown) => my === seq.current && setCheck({ phase: 'error', message: describeError(e, 'Could not read the task folder. Try again.') }),
      )
    }, 350)
    return () => {
      window.clearTimeout(t)
      seq.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])

  return { check, retry: () => setAttempt((n) => n + 1) }
}
