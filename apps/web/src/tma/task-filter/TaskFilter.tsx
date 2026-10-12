/**
 * Task Filter (design: "Task Filter.dc.html"). One component for screen 01 (variant "modal", mode
 * "rank") and screen 03 (variant "inline", mode "run"). It loads the catalog itself (GET /tasks,
 * GET /tags, shared per session in useTaskCatalog), so callers pass only the selection.
 *
 * - modal: a centered dialog. The selection is a draft until "Apply" (`onApply`); "Cancel", the
 *   close button, Escape and a scrim click call `onClose`. Mount it only while it is open.
 * - inline: always visible. `selected` is controlled; every toggle calls `onChange`.
 * - mode "browse" (inline only, the All tab of /tasks): the public catalog as a list to read, not to
 *   pick. No checkboxes; a row opens the task's details page /tasks/:slug when it has one.
 *
 * Ids are catalog task ids. `onApply` and `onChange` also receive the selected Task objects.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { hasPublicPage, publicTaskHref } from '../../lib/task-links'
import type { Tag, Task } from '../../lib/api'
import { Button } from '../ui/Button'
import { IconClose } from '../ui/icons'
import { useTaskCatalog, type TaskCatalog } from './useTaskCatalog'

export interface TaskFilterProps {
  variant?: 'modal' | 'inline'
  mode?: 'rank' | 'run' | 'browse'
  /** Selected task ids. */
  selected?: string[]
  /** Modal: the user pressed Apply. */
  onApply?: (ids: string[], tasks: Task[]) => void
  /** Inline: every toggle and Clear. */
  onChange?: (ids: string[], tasks: Task[]) => void
  /** Modal: close without applying (Cancel, ×, Escape, scrim, and after Apply). */
  onClose?: () => void
}

type Source = 'all' | 'public' | 'mine'

const SOURCES: Array<{ id: Source; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'public', label: 'Public' },
  { id: 'mine', label: 'My tasks' },
]

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function metaOf(t: Task, mode: 'rank' | 'run' | 'browse'): string {
  if (mode === 'run') {
    if (!t.runnable) return 'Not runnable'
    return `${t.hiddenTestsCount ?? '—'} tests · ~${t.estMinutes ?? '—'}m`
  }
  return t.agentsRunCount > 0 ? plural(t.agentsRunCount, 'agent') : 'Not run yet'
}

function Check({ on }: { on: boolean }) {
  return (
    <span className={on ? 'tmf-box tmf-box--on' : 'tmf-box'} aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.75" style={{ opacity: on ? 1 : 0 }}>
        <path d="M2 5.2 4 7.2 8 2.8" />
      </svg>
    </span>
  )
}

function SourceControl({ source, onChange, catalog, layout }: { source: Source; onChange: (s: Source) => void; catalog: TaskCatalog | null; layout: 'list' | 'segmented' }) {
  const count = (id: Source) => (catalog ? catalog.counts[id] : 0)
  if (layout === 'list') {
    return (
      <>
        {SOURCES.map((s) => (
          <button key={s.id} type="button" className="tmf-item" aria-pressed={source === s.id} data-selected={source === s.id ? 'source' : undefined} onClick={() => onChange(s.id)}>
            {s.label}
            <span className="tmf-count">{count(s.id)}</span>
          </button>
        ))}
      </>
    )
  }
  return (
    <div className="tmf-segmented" role="group" aria-label="Source">
      {SOURCES.map((s) => (
        <button key={s.id} type="button" className="tmf-segmented__btn" aria-pressed={source === s.id} onClick={() => onChange(s.id)}>
          {s.label}
          <span className="tmf-count">{count(s.id)}</span>
        </button>
      ))}
    </div>
  )
}

function TagList({ heading, tags, active, countOf, onToggle }: { heading: string; tags: Tag[]; active: string | null; countOf: (g: Tag) => number; onToggle: (id: string) => void }) {
  return (
    <>
      <span className="tmf-heading">{heading}</span>
      {tags.map((g) => (
        <button key={g.id} type="button" className="tmf-item" aria-pressed={active === g.id} data-selected={active === g.id ? 'tag' : undefined} onClick={() => onToggle(g.id)}>
          {g.name}
          <span className="tmf-count">{countOf(g)}</span>
        </button>
      ))}
    </>
  )
}

/** Browse mode: one catalog task. A public task is a link to /tasks/:slug; any other is plain. */
function BrowseRow({ task: t }: { task: Task }) {
  const body = (
    <>
      <div className="tmf-row__main">
        <span className="tmf-row__title">
          <span className="tmf-row__name">{t.name}</span>
          {t.mine && <span className="tmf-mine">Mine</span>}
        </span>
        <span className="tmf-row__desc">{t.description}</span>
      </div>
      <div className="tmf-row__tags">
        {t.tags.map((g) => (
          <span key={g.id} className="tmf-tag">
            {g.name}
          </span>
        ))}
      </div>
      <span className="tmf-row__meta">{metaOf(t, 'browse')}</span>
    </>
  )
  const href = publicTaskHref(t)
  return href ? (
    <Link to={href} className="tmf-row tmf-row--inline tmf-row--browse" data-testid="task-filter-row" data-task-id={t.id}>
      {body}
    </Link>
  ) : (
    <div className="tmf-row tmf-row--inline tmf-row--browse tmf-row--static" data-testid="task-filter-row" data-task-id={t.id}>
      {body}
    </div>
  )
}

export function TaskFilter({ variant = 'modal', mode = 'rank', selected = [], onApply, onChange, onClose }: TaskFilterProps) {
  const state = useTaskCatalog()
  const catalog = state.status === 'ready' ? state.catalog : null
  const [q, setQ] = useState('')
  const [source, setSource] = useState<Source>('all')
  const [tag, setTag] = useState<string | null>(null)
  const [draft, setDraft] = useState<string[]>(selected)
  const browse = mode === 'browse'
  const inline = variant === 'inline' || browse
  const ids = inline ? selected : draft

  useEffect(() => {
    if (inline || !onClose) return
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [inline, onClose])

  const inSource = (t: Task) => (browse ? t.visibility === 'public' : source === 'all' || (source === 'mine' ? t.mine : !t.mine))
  const visible = useMemo(() => {
    if (!catalog) return []
    const needle = q.trim().toLowerCase()
    return catalog.tasks.filter(
      (t) =>
        inSource(t) &&
        (!tag || t.tags.some((g) => g.id === tag)) &&
        (!needle || [t.name, t.id, t.slug, t.description, ...t.tags.map((g) => g.name)].join(' ').toLowerCase().includes(needle)),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, q, source, tag])

  const tasksOf = (list: string[]) => (catalog ? catalog.tasks.filter((t) => list.includes(t.id)) : [])
  const commit = (next: string[]) => {
    if (inline) onChange?.(next, tasksOf(next))
    else {
      setDraft(next)
      onChange?.(next, tasksOf(next))
    }
  }
  const selectable = (t: Task) => mode !== 'run' || t.runnable
  const toggle = (t: Task) => {
    if (!selectable(t)) return
    commit(ids.includes(t.id) ? ids.filter((x) => x !== t.id) : [...ids, t.id])
  }
  const onRowKey = (e: KeyboardEvent, t: Task) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      toggle(t)
    }
  }
  const tagCount = (g: Tag) => (catalog ? catalog.tasks.filter((t) => inSource(t) && t.tags.some((x) => x.id === g.id)).length : 0)
  const toggleTag = (id: string) => setTag((cur) => (cur === id ? null : id))

  const n = ids.length
  const applyLabel = mode === 'run' ? `Use ${plural(n, 'task')}` : n ? `Rank on ${plural(n, 'task')}` : 'Show all agents'
  const title = mode === 'run' ? 'Choose tasks' : 'Rank agents on tasks'

  const search = (
    <input
      className="tmf-search"
      type="search"
      value={q}
      onChange={(e) => setQ(e.target.value)}
      placeholder="Search tasks, tools, concepts"
      aria-label="Search tasks, tools, concepts"
    />
  )

  const rows = (
    <>
      {state.status === 'loading' &&
        [0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={inline ? 'tmf-row tmf-row--inline tmf-row--skeleton' : 'tmf-row tmf-row--skeleton'} data-testid="task-filter-skeleton">
            <span className="tmf-box" />
            <span className="tmf-skel" style={{ width: `${48 + ((i * 13) % 30)}%` }} />
            <span />
            <span className="tmf-skel" style={{ width: 56, justifySelf: 'end' }} />
          </div>
        ))}
      {state.status === 'error' && (
        <div className="tmf-empty" role="alert">
          <span>{state.message}</span>{' '}
          <Button variant="text" onClick={state.reload}>
            Try again
          </Button>
        </div>
      )}
      {catalog &&
        visible.map((t) => {
          if (browse) return <BrowseRow key={t.id} task={t} />
          const on = ids.includes(t.id)
          const ok = selectable(t)
          return (
            <div
              key={t.id}
              role="checkbox"
              aria-checked={on}
              aria-disabled={!ok}
              tabIndex={0}
              data-testid="task-filter-row"
              data-task-id={t.id}
              className={['tmf-row', inline && 'tmf-row--inline', on && 'tmf-row--on', !ok && 'tmf-row--disabled'].filter(Boolean).join(' ')}
              onClick={() => toggle(t)}
              onKeyDown={(e) => onRowKey(e, t)}
              title={ok ? undefined : 'This task cannot run yet.'}
            >
              <Check on={on} />
              <div className="tmf-row__main">
                <span className="tmf-row__title">
                  {hasPublicPage(t) ? (
                    <Link className="tmf-row__name tma-task-link" to={publicTaskHref(t)!} target="_blank" rel="noopener" data-testid="task-link" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      {t.name}
                    </Link>
                  ) : (
                    <span className="tmf-row__name">{t.name}</span>
                  )}
                  {t.mine && <span className="tmf-mine">{t.visibility === 'draft' ? 'Mine · draft' : 'Mine · private'}</span>}
                </span>
                <span className="tmf-row__desc">{t.description}</span>
              </div>
              <div className="tmf-row__tags">
                {t.tags.map((g) => (
                  <span key={g.id} className="tmf-tag">
                    {g.name}
                  </span>
                ))}
              </div>
              <span className="tmf-row__meta">{metaOf(t, mode)}</span>
            </div>
          )
        })}
      {catalog && visible.length === 0 && <div className="tmf-empty">No tasks match.</div>}
    </>
  )

  if (inline) {
    return (
      <div className="tmf tmf-inline" data-testid={browse ? 'task-filter-browse' : 'task-filter-inline'}>
        <div className={browse ? 'tmf-inline__bar tmf-inline__bar--browse' : 'tmf-inline__bar'}>
          {!browse && <SourceControl source={source} onChange={setSource} catalog={catalog} layout="segmented" />}
          {search}
        </div>
        <div className="tmf-inline__body">
          <div className="tmf-inline__side">
            <TagList heading="Tools" tags={catalog?.tools ?? []} active={tag} countOf={tagCount} onToggle={toggleTag} />
            <TagList heading="Concepts" tags={catalog?.concepts ?? []} active={tag} countOf={tagCount} onToggle={toggleTag} />
            <Link className="tmf-new" to="/tasks/new">
              + New task
            </Link>
          </div>
          <div className="tmf-inline__rows">{rows}</div>
        </div>
      </div>
    )
  }

  return createPortal(
    <div className="tmf tmf-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="tmf-modal" role="dialog" aria-modal="true" aria-label={title} data-testid="task-filter-modal">
        <div className="tmf-modal__header">
          <div className="tmf-modal__titles">
            <span className="tmf-modal__title">{title}</span>
            <span className="tmf-modal__sub">Scores use only the tasks you pick. Your private tasks are visible only to you.</span>
          </div>
          <button type="button" className="tmf-close" aria-label="Close" onClick={onClose}>
            <IconClose width={14} height={14} />
          </button>
        </div>
        <div className="tmf-modal__body">
          <div className="tmf-modal__side">
            <span className="tmf-heading">Source</span>
            <SourceControl source={source} onChange={setSource} catalog={catalog} layout="list" />
            <TagList heading="Tools" tags={catalog?.tools ?? []} active={tag} countOf={tagCount} onToggle={toggleTag} />
            <TagList heading="Concepts" tags={catalog?.concepts ?? []} active={tag} countOf={tagCount} onToggle={toggleTag} />
            <Link className="tmf-new tmf-new--modal" to="/tasks/new" onClick={onClose}>
              + New task
            </Link>
          </div>
          <div className="tmf-modal__main">
            <div className="tmf-modal__search">{search}</div>
            <div className="tmf-modal__rows">{rows}</div>
          </div>
        </div>
        <div className="tmf-modal__footer">
          <span className="tmf-modal__count" data-testid="task-filter-count">
            {n} selected
          </span>
          <div className="tmf-modal__actions">
            <button type="button" className="tmf-btn tmf-btn--ghost" onClick={() => commit([])}>
              Clear
            </button>
            <button type="button" className="tmf-btn tmf-btn--secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="tmf-btn tmf-btn--primary"
              data-testid="task-filter-apply"
              onClick={() => {
                onApply?.(draft, tasksOf(draft))
                onClose?.()
              }}
            >
              {applyLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
