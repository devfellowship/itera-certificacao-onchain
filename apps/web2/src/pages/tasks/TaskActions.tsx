import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Task } from '../../lib/api'

export const editHref = (t: Pick<Task, 'id'>) => `/tasks/${encodeURIComponent(t.id)}/edit`
export const rankHref = (t: Pick<Task, 'id'>) => `/agents?tasks=${encodeURIComponent(t.id)}`

/** Row action: Rank agents → (ready), Finish draft / Fix task (own drafts), Validating…; a draft also has a ⋯ menu to delete it. */
export function TaskAction({ task: t, onDelete }: { task: Task; onDelete: (t: Task) => void }) {
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  let action
  if (t.status === 'ready') {
    action = (
      <Link to={rankHref(t)} className="tkp-action" onClick={stop} data-testid="rank-agents">
        Rank agents →
      </Link>
    )
  } else if (t.status === 'validating') {
    action = <span className="tkp-action tkp-action--off">Validating…</span>
  } else {
    action = (
      <Link to={editHref(t)} className="tkp-action" onClick={stop}>
        {t.status === 'invalid' ? 'Fix task' : 'Finish draft'}
      </Link>
    )
  }
  return (
    <span className="tkp-actions" ref={ref}>
      {action}
      {t.mine && t.status === 'draft' && (
        <>
          <button
            type="button"
            className="tkp-menu-btn"
            aria-label={`More actions for ${t.name}`}
            aria-expanded={menu}
            onClick={(e) => {
              stop(e)
              setMenu((m) => !m)
            }}
          >
            ⋯
          </button>
          {menu && (
            <span className="tkp-menu" role="menu" onClick={stop}>
              <button
                type="button"
                role="menuitem"
                className="tkp-menu__item"
                onClick={() => {
                  setMenu(false)
                  onDelete(t)
                }}
              >
                Delete draft
              </button>
            </span>
          )}
        </>
      )}
    </span>
  )
}
