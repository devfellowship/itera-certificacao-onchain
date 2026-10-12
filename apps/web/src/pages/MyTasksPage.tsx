/**
 * Screen 10 — My tasks (design "10 My Tasks.dc.html", designer handoff U26 section "10 My tasks";
 * plan 20261012-itera-testmyagent-ui-refactor, U20).
 * Data: GET /tasks?source=mine (catalog list, status + counts), GET /tasks/:id per task (the
 * GitHub pin and the open / sealed label, U19), GET /agents/ranking?taskIds=<id> (best result,
 * owner only). Row click → the task editor /tasks/:id/edit.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, api } from '../lib/api'
import type { Task, TaskStatus, UserTaskDetail } from '../lib/api'
import { Badge, Button, ButtonLink, Card, Table, TableEmpty, TagPill, type Column, type Tone } from '../tma/ui'
import { TestsLabel, LockIcon } from './task-editor/labels'
import './my-tasks.css'

/** Task validation state (handoff: the VISIBILITY column becomes STATUS). */
export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  validating: { label: 'Validating', tone: 'warning' },
  ready: { label: 'Ready', tone: 'success' },
  invalid: { label: 'Invalid', tone: 'danger' },
}

const editHref = (t: Pick<Task, 'id'>) => `/tasks/${encodeURIComponent(t.id)}/edit`
const rankHref = (t: Pick<Task, 'id'>) => `/agents?tasks=${encodeURIComponent(t.id)}`

interface Row {
  task: Task
  detail: UserTaskDetail | null
  best: { name: string; score: number } | null
}

function ActionCell({ row, onDelete }: { row: Row; onDelete: (t: Task) => void }) {
  const t = row.task
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
  if (t.status === 'ready')
    action = (
      <Link to={rankHref(t)} className="tmt-action" onClick={stop} data-testid="rank-agents">
        Rank agents →
      </Link>
    )
  else if (t.status === 'validating') action = <span className="tmt-action tmt-action--off">Validating…</span>
  else
    action = (
      <Link to={editHref(t)} className="tmt-action" onClick={stop}>
        {t.status === 'invalid' ? 'Fix task' : 'Finish draft'}
      </Link>
    )
  return (
    <span className="tmt-actions" ref={ref}>
      {action}
      {t.status === 'draft' && (
        <>
          <button
            type="button"
            className="tmt-menu-btn"
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
            <span className="tmt-menu" role="menu" onClick={stop}>
              <button
                type="button"
                role="menuitem"
                className="tmt-menu__item tmt-menu__item--danger"
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

/** Name + description, as the mock. The pin (owner/repo@sha · path) is the row's tooltip, so the row keeps the mock's height. */
function TaskCell({ row }: { row: Row }) {
  const { task: t, detail } = row
  const v = detail?.latestVersion ?? null
  return (
    <span className="tmt-task" title={v ? `${v.github.repo}@${v.github.shortSha} · ${v.github.path} · v${v.version}` : undefined}>
      <span className="tmt-task__name">{t.name}</span>
      <span className="tmt-task__desc">{t.description}</span>
      {v && (
        <span className="tmt-sr" data-testid="task-pin">
          {v.github.repo}@{v.github.shortSha}
        </span>
      )}
    </span>
  )
}

/** Validation state, and under it the Private lock + Open / Sealed tests label (Gate Q7). */
function StatusCell({ row }: { row: Row }) {
  const t = row.task
  const s = TASK_STATUS[t.status] ?? { label: t.status, tone: 'neutral' as Tone }
  const tv = row.detail?.latestVersion?.testsVisibility ?? (t.labels?.includes('open-tests') ? 'open' : t.labels?.includes('sealed-tests') ? 'sealed' : null)
  return (
    <span className="tmt-status" data-testid={`task-status-${t.status}`}>
      <Badge tone={s.tone}>{s.label}</Badge>
      {tv && (
        <span className="tmt-status__sub">
          <LockIcon title="Private: visible only to you" />
          <TestsLabel visibility={tv} short />
        </span>
      )}
    </span>
  )
}

function columns(onDelete: (t: Task) => void): Column<Row>[] {
  return [
    { key: 'task', header: 'Task', width: 'minmax(0,1fr)', render: (r) => <TaskCell row={r} /> },
    {
      key: 'tags',
      header: 'Tags',
      width: '200px',
      render: (r) => (
        <span className="tmt-tags">
          {r.task.tags.map((g) => (
            <TagPill key={g.id}>{g.name}</TagPill>
          ))}
        </span>
      ),
    },
    { key: 'status', header: 'Status', width: '100px', render: (r) => <StatusCell row={r} /> },
    { key: 'tests', header: 'Tests', width: '70px', align: 'right', render: (r) => <span className="tmt-num">{r.task.hiddenTestsCount ?? '—'}</span> },
    { key: 'agents', header: 'Agents', width: '90px', align: 'right', render: (r) => <span className="tmt-num tmt-muted">{r.task.agentsRunCount > 0 ? r.task.agentsRunCount : '—'}</span> },
    {
      key: 'best',
      header: 'Best result',
      width: '170px',
      render: (r) =>
        r.best ? (
          <span className="tmt-best">
            {r.best.name} <span className="tmt-best__score">{r.best.score.toFixed(1)}</span>
          </span>
        ) : (
          <span className="tmt-best">{r.task.agentsRunCount > 0 ? '…' : 'Not run'}</span>
        ),
    },
    { key: 'action', header: '', width: '130px', align: 'right', render: (r) => <ActionCell row={r} onDelete={onDelete} /> },
  ]
}

const SKELETON: Column<number>[] = [
  {
    key: 'task',
    header: 'Task',
    width: 'minmax(0,1fr)',
    render: () => (
      <span className="tmt-task">
        <span className="tmt-skel" style={{ width: '60%' }} />
        <span className="tmt-skel" style={{ width: '85%', height: 10 }} />
      </span>
    ),
  },
  { key: 'tags', header: 'Tags', width: '200px', render: () => <span className="tmt-skel" style={{ width: 140, height: 22 }} /> },
  { key: 'status', header: 'Status', width: '100px', render: () => <span className="tmt-skel" style={{ width: 64, height: 20 }} /> },
  { key: 'tests', header: 'Tests', width: '70px', align: 'right', render: () => <span className="tmt-skel tmt-skel--r" style={{ width: 24 }} /> },
  { key: 'agents', header: 'Agents', width: '90px', align: 'right', render: () => <span className="tmt-skel tmt-skel--r" style={{ width: 24 }} /> },
  { key: 'best', header: 'Best result', width: '170px', render: () => <span className="tmt-skel" style={{ width: 110 }} /> },
  { key: 'action', header: '', width: '130px', align: 'right', render: () => <span className="tmt-skel tmt-skel--r" style={{ width: 90 }} /> },
]

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; rows: Row[] }

/** Best result of the owner's runs on one task: the top scored agent of the ranking on that task. */
async function bestOn(taskId: string): Promise<Row['best']> {
  const { rows } = await api.ranking({ taskIds: [taskId] })
  const scored = rows.filter((r) => r.score != null && (r.coverage?.k ?? 1) > 0)
  if (!scored.length) return null
  const top = scored.reduce((a, b) => ((b.score ?? -1) > (a.score ?? -1) ? b : a))
  return { name: top.name, score: top.score! }
}

const EXPLAINERS = [
  { n: '01 · Contract', t: 'What the agent receives', d: 'A prompt and a repo at a pinned commit. Read through the GitHub App. Digests are recorded when a run starts.' },
  { n: '02 · Hidden tests', t: 'How it is graded', d: "Kept out of the agent's sandbox. They run in a separate container. In a public repo anyone can read them (open tests)." },
  { n: '03 · Tags', t: 'Where it shows up', d: 'Tools and concepts like Stripe API or Idempotency. Used to filter and rank.' },
]

export function MyTasksPage() {
  const navigate = useNavigate()
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoad((l) => (l.state === 'ready' ? l : { state: 'loading' }))
    api
      .tasks({ source: 'mine' })
      .then(async ({ tasks }) => {
        const mine = tasks.filter((t) => t.mine)
        if (cancelled) return
        setLoad({ state: 'ready', rows: mine.map((task) => ({ task, detail: null, best: null })) })
        // Details (pin, open / sealed) and best results fill in per row; a failure leaves the row as it is.
        await Promise.all(
          mine.map(async (task) => {
            const [detail, best] = await Promise.all([
              api.myTask(task.id).then((r) => r.task ?? null, () => null),
              task.agentsRunCount > 0 ? bestOn(task.id).catch(() => null) : Promise.resolve(null),
            ])
            if (cancelled) return
            setLoad((l) => (l.state === 'ready' ? { state: 'ready', rows: l.rows.map((r) => (r.task.id === task.id ? { ...r, detail, best } : r)) } : l))
          }),
        )
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoad({ state: 'error', message: err instanceof ApiError || err instanceof Error ? err.message : 'Request failed' })
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const onDelete = useCallback(async (t: Task) => {
    if (!window.confirm(`Delete the draft "${t.name}"? This cannot be undone.`)) return
    try {
      await api.deleteTask(t.id)
      setNotice(`Deleted "${t.name}".`)
      setLoad((l) => (l.state === 'ready' ? { state: 'ready', rows: l.rows.filter((r) => r.task.id !== t.id) } : l))
    } catch (e) {
      setNotice(e instanceof ApiError ? `Could not delete the draft: ${e.message}` : 'Could not delete the draft. Try again.')
    }
  }, [])

  let body
  if (load.state === 'loading') {
    body = (
      <div aria-busy="true" data-testid="tasks-loading">
        <Table columns={SKELETON} rows={[0, 1, 2]} rowKey={(r) => String(r)} testId="tasks-skeleton" />
      </div>
    )
  } else if (load.state === 'error') {
    body = (
      <div className="tma-table" data-testid="tasks-error" role="alert">
        <TableEmpty title="Could not load your tasks">
          <span className="tmt-empty-text">{load.message}</span>
          <Button variant="secondary" size={32} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </TableEmpty>
      </div>
    )
  } else {
    body = (
      <Table
        columns={columns(onDelete)}
        rows={load.rows}
        rowKey={(r) => r.task.id}
        onRowClick={(r) => navigate(editHref(r.task))}
        testId="tasks-table"
        empty={
          <TableEmpty title="No tasks yet">
            <span className="tmt-empty-text">Write a task in a GitHub repo, pin a commit, and validate it. Then rank any agent against it.</span>
            <Link to="/tasks/new" className="tma-body-sm">
              New task →
            </Link>
          </TableEmpty>
        }
      />
    )
  }

  return (
    <main className="tma-page tmt" data-testid="my-tasks">
      <div className="tmt-head">
        <div className="tmt-head__text">
          <h1 className="tma-h1">My tasks</h1>
          <span className="tmt-sub">Write a task once. Rank any agent against it.</span>
        </div>
        <ButtonLink variant="primary" href="/tasks/new" data-testid="new-task">
          New task
        </ButtonLink>
      </div>

      {notice && (
        <span className="tmt-notice" role="status">
          {notice}
        </span>
      )}

      {body}

      <div className="tmt-explainers">
        {EXPLAINERS.map((x) => (
          <Card key={x.n} className="tmt-explainer">
            <span className="tma-label">{x.n}</span>
            <span className="tmt-explainer__t">{x.t}</span>
            <span className="tmt-explainer__d">{x.d}</span>
          </Card>
        ))}
      </div>
    </main>
  )
}
