import type { MouseEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { lookupTask, publicTaskHref, type TaskRef } from '../../lib/task-links'
import { useTaskCatalog } from './useTaskCatalog'

/** Resolver `(ref) => "/tasks/:slug" | null` over the shared task catalog (one request per session, works signed out). */
export function useTaskLinks(): (ref: TaskRef) => string | null {
  const state = useTaskCatalog()
  return (ref) => (state.status === 'ready' ? publicTaskHref(lookupTask(state.catalog.tasks, ref) ?? {}) : null)
}

/**
 * A task's name. A public task links to its details page `/tasks/:slug`; any other task stays plain text.
 * `newTab` is for lists that hold a selection (the Task Filter), so the click does not lose it.
 */
export function TaskName({
  name,
  taskId,
  slug,
  newTab,
  className,
  children,
}: {
  name: string
  taskId?: string | null
  slug?: string | null
  newTab?: boolean
  className?: string
  children?: ReactNode
}) {
  const hrefFor = useTaskLinks()
  const href = hrefFor({ id: taskId, slug })
  const label = children ?? name
  if (!href) return <span className={className}>{label}</span>
  const stop = (e: MouseEvent) => e.stopPropagation()
  return (
    <Link
      to={href}
      className={['tma-task-link', className].filter(Boolean).join(' ')}
      data-testid="task-link"
      onClick={stop}
      onKeyDown={(e) => e.stopPropagation()}
      {...(newTab ? { target: '_blank', rel: 'noopener' } : {})}
    >
      {label}
    </Link>
  )
}
