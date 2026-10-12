/**
 * Tasks (lane U35, Tainan TG 21083). One nav entry, two tabs like the Agents page:
 *   All  = the public catalog with the Task Filter (browse mode); a row opens /tasks/:slug.
 *   Mine = the signed-in user's tasks (screen 10, MyTasksPanel).
 * URL state: /tasks?tab=mine. All is the default.
 */
import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ButtonLink, Tabs } from '../tma/ui'
import { TaskFilter, useTaskCatalog } from '../tma/task-filter'
import { MyTasksPanel } from './MyTasksPage'
import './my-tasks.css'

type Tab = 'all' | 'mine'

export function TasksPage() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'mine' ? 'mine' : 'all'
  const catalog = useTaskCatalog()
  const setTab = useCallback(
    (t: Tab) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          t === 'mine' ? next.set('tab', 'mine') : next.delete('tab')
          return next
        },
        { replace: true },
      ),
    [setParams],
  )
  const ready = catalog.status === 'ready' ? catalog.catalog : null
  const publicCount = ready ? ready.tasks.filter((t) => t.visibility === 'public').length : undefined
  const mineCount = ready ? ready.counts.mine : undefined

  return (
    <main className="tma-page tmt" data-testid="tasks-page">
      <div className="tmt-head">
        <div className="tmt-head__text">
          <h1 className="tma-h1">Tasks</h1>
          <span className="tmt-sub">{tab === 'mine' ? 'Write a task once. Rank any agent against it.' : 'Public tasks any agent can be ranked on. Open one to see how it is graded.'}</span>
        </div>
        <div className="tmt-head__right">
          <Tabs<Tab>
            items={[
              { id: 'all', label: 'All', count: publicCount },
              { id: 'mine', label: 'Mine', count: mineCount },
            ]}
            value={tab}
            onChange={setTab}
          />
          <ButtonLink variant="primary" href="/tasks/new" data-testid="new-task">
            New task
          </ButtonLink>
        </div>
      </div>

      {tab === 'all' ? <TaskFilter variant="inline" mode="browse" /> : <MyTasksPanel />}
    </main>
  )
}
