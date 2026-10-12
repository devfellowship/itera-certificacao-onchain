/**
 * Tasks (lane U35; Tainan TG 21083, designer reference TG 21105). One list of every task the caller can
 * see: the public catalog and the caller's own tasks. Tabs All / Mine, search, tag chips with counts,
 * and a table: TASK, AUTHOR, TAGS, AGENTS, BEST RESULT, action.
 * Data: GET /tasks?include=overview (author, agentsCount, bestResult are computed by the API from the runs).
 * A public task opens /tasks/:slug; an own task that is not public opens the editor /tasks/:id/edit.
 * URL state: /tasks?tab=mine&q=&tag=.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, api } from '../lib/api'
import type { Tag, Task } from '../lib/api'
import { publicTaskHref } from '../lib/task-links'
import { Button, ButtonLink, Card, Chip, SearchInput, Table, TableEmpty, Tabs, TagPill, type Column } from '../tma/ui'
import { TaskName } from '../tma/task-filter'
import { AgentTile, AuthorAvatar } from './tasks/people'
import { editHref, TaskAction } from './tasks/TaskActions'
import './tasks/tasks.css'

type Tab = 'all' | 'mine'
type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; tasks: Task[]; counts: { all: number; mine: number } }

const EXPLAINERS = [
  { n: '01 · Contract', t: 'What the agent receives', d: 'A prompt and a repo snapshot. Frozen and hashed when a run starts.' },
  { n: '02 · Hidden tests', t: 'How it is graded', d: 'Never shown to agents or their vendors. They run outside the agent sandbox.' },
  { n: '03 · Tags', t: 'Where it shows up', d: 'Tools and concepts like Stripe API or Idempotency. Used to filter and rank.' },
]

/** PRIVATE / DRAFT / VALIDATING / INVALID pill next to the title. */
function StatePill({ task: t }: { task: Task }) {
  const label = t.status === 'draft' ? 'Draft' : t.status === 'validating' ? 'Validating' : t.status === 'invalid' ? 'Invalid' : t.visibility === 'private' ? 'Private' : null
  return label ? (
    <span className="tkp-pill" data-testid={`state-${label.toLowerCase()}`}>
      {label}
    </span>
  ) : null
}

function tagsOf(tasks: Task[]): Array<Tag & { count: number }> {
  const seen = new Map<string, Tag & { count: number }>()
  for (const t of tasks) for (const g of t.tags) seen.set(g.id, { ...g, count: (seen.get(g.id)?.count ?? 0) + 1 })
  // Tools first, then concepts, the order the Task Filter uses (kind desc: tool, concept), by count.
  return [...seen.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tool' ? -1 : 1) || b.count - a.count || a.name.localeCompare(b.name))
}

function columns(onDelete: (t: Task) => void): Column<Task>[] {
  return [
    {
      key: 'task',
      header: 'Task',
      width: 'minmax(0,1fr)',
      render: (t) => (
        <span className="tkp-task">
          <span className="tkp-task__title">
            <TaskName className="tkp-task__name" name={t.name} taskId={t.id} slug={t.slug} />
            <StatePill task={t} />
          </span>
          <span className="tkp-task__desc">{t.description}</span>
        </span>
      ),
    },
    {
      key: 'author',
      header: 'Author',
      width: '170px',
      render: (t) => {
        const a = t.author
        const name = t.mine ? 'you' : (a?.name ?? '—')
        return (
          <span className="tkp-author" data-testid="task-author">
            <AuthorAvatar name={a?.name ?? name} src={a?.avatarUrl} />
            <span className="tkp-author__name">{name}</span>
          </span>
        )
      },
    },
    {
      key: 'tags',
      header: 'Tags',
      width: '210px',
      render: (t) => (
        <span className="tkp-tags">
          {t.tags.map((g) => (
            <TagPill key={g.id}>{g.name}</TagPill>
          ))}
        </span>
      ),
    },
    { key: 'agents', header: 'Agents', width: '64px', align: 'right', render: (t) => <span className="tkp-num">{t.agentsCount ? t.agentsCount : '–'}</span> },
    {
      key: 'best',
      header: 'Best result',
      width: '190px',
      render: (t) =>
        t.bestResult ? (
          <span className="tkp-best" data-testid="task-best">
            <AgentTile name={t.bestResult.agent.name} initials={t.bestResult.agent.initials} src={t.bestResult.agent.avatarUrl} />
            <span className="tkp-best__name">{t.bestResult.agent.name}</span>
            <span className="tkp-best__score">{t.bestResult.score.toFixed(1)}</span>
          </span>
        ) : (
          <span className="tkp-best tkp-best--none">Not run</span>
        ),
    },
    { key: 'action', header: '', width: '120px', align: 'right', render: (t) => <TaskAction task={t} onDelete={onDelete} /> },
  ]
}

const skel = (key: string, header: string, width: string, w: number | string): Column<number> => ({ key, header, width, render: () => <span className="tkp-skel" style={{ width: w }} /> })
const SKELETON: Column<number>[] = [
  skel('task', 'Task', 'minmax(0,1fr)', '55%'),
  skel('author', 'Author', '170px', 90),
  skel('tags', 'Tags', '210px', 120),
  skel('agents', 'Agents', '64px', 20),
  skel('best', 'Best result', '190px', 110),
  skel('action', '', '120px', 80),
]

export function TasksPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'mine' ? 'mine' : 'all'
  const q = params.get('q') ?? ''
  const tag = params.get('tag')
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const update = useCallback(
    (patch: { tab?: Tab; q?: string; tag?: string | null }) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (patch.tab !== undefined) patch.tab === 'mine' ? next.set('tab', 'mine') : next.delete('tab')
          if (patch.q !== undefined) patch.q ? next.set('q', patch.q) : next.delete('q')
          if (patch.tag !== undefined) patch.tag ? next.set('tag', patch.tag) : next.delete('tag')
          return next
        },
        { replace: true },
      ),
    [setParams],
  )

  useEffect(() => {
    let alive = true
    setLoad((l) => (l.state === 'ready' ? l : { state: 'loading' }))
    api.tasks({ source: 'all', include: 'overview' }).then(
      (r) => alive && setLoad({ state: 'ready', tasks: r.tasks, counts: { all: r.counts.all, mine: r.counts.mine } }),
      (e: unknown) => alive && setLoad({ state: 'error', message: e instanceof ApiError || e instanceof Error ? e.message : 'Request failed' }),
    )
    return () => {
      alive = false
    }
  }, [attempt])

  const onDelete = useCallback(async (t: Task) => {
    if (!window.confirm(`Delete the draft "${t.name}"? This cannot be undone.`)) return
    try {
      await api.deleteTask(t.id)
      setNotice(`Deleted "${t.name}".`)
      setAttempt((n) => n + 1)
    } catch (e) {
      setNotice(e instanceof ApiError ? `Could not delete the draft: ${e.message}` : 'Could not delete the draft. Try again.')
    }
  }, [])

  const tasks = load.state === 'ready' ? load.tasks : []
  const inTab = useMemo(() => tasks.filter((t) => tab === 'all' || t.mine), [tasks, tab])
  const chips = useMemo(() => tagsOf(inTab), [inTab])
  const needle = q.trim().toLowerCase()
  const rows = useMemo(
    () =>
      inTab.filter(
        (t) => (!tag || t.tags.some((g) => g.id === tag)) && (!needle || [t.name, t.slug, t.description, t.author?.name ?? '', ...t.tags.map((g) => g.name)].join(' ').toLowerCase().includes(needle)),
      ),
    [inTab, tag, needle],
  )

  const onRow = (t: Task) => navigate(publicTaskHref(t) ?? (t.mine ? editHref(t) : `/tasks/${encodeURIComponent(t.slug)}`))

  let body: React.ReactNode
  if (load.state === 'loading') {
    body = (
      <div aria-busy="true" data-testid="tasks-loading">
        <Table columns={SKELETON} rows={[0, 1, 2, 3]} rowKey={(r) => String(r)} testId="tasks-skeleton" />
      </div>
    )
  } else if (load.state === 'error') {
    body = (
      <div className="tma-table" data-testid="tasks-error" role="alert">
        <TableEmpty title="Could not load tasks">
          <span className="tkp-empty-text">{load.message}</span>
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
        rows={rows}
        rowKey={(t) => t.id}
        onRowClick={onRow}
        testId="tasks-table"
        empty={
          <TableEmpty title={tab === 'mine' && !needle && !tag ? 'No tasks yet' : 'No tasks match these filters.'}>
            <span className="tkp-empty-text">
              {tab === 'mine' && !needle && !tag ? 'Write a task in a GitHub repo, pin a commit, and validate it. Then rank any agent against it.' : 'Try another tag or search.'}
            </span>
            {tab === 'mine' && !needle && !tag ? (
              <ButtonLink variant="text" href="/tasks/new">
                New task →
              </ButtonLink>
            ) : (
              <Button variant="text" onClick={() => update({ q: '', tag: null })}>
                Clear filters
              </Button>
            )}
          </TableEmpty>
        }
      />
    )
  }

  return (
    <main className="tma-page tkp" data-testid="tasks-page">
      <div className="tkp-head">
        <div className="tkp-head__text">
          <h1 className="tma-h1">Tasks</h1>
          <span className="tkp-sub">Public catalog and your private tasks. Rank any agent against them.</span>
        </div>
        <ButtonLink variant="primary" href="/tasks/new" data-testid="new-task">
          New task
        </ButtonLink>
      </div>

      <div className="tkp-controls">
        <Tabs<Tab>
          items={[
            { id: 'all', label: 'All', count: load.state === 'ready' ? load.counts.all : undefined },
            { id: 'mine', label: 'Mine', count: load.state === 'ready' ? load.counts.mine : undefined },
          ]}
          value={tab}
          onChange={(t) => update({ tab: t, tag: null })}
        />
        <div className="tkp-controls__right">
          <SearchInput width={280} value={q} onChange={(e) => update({ q: e.target.value })} placeholder="Search tasks, tools, concepts" aria-label="Search tasks, tools, concepts" />
        </div>
      </div>

      {chips.length > 0 && (
        <div className="tkp-chips" data-testid="tag-chips">
          {chips.map((g) => (
            <Chip key={g.id} selected={tag === g.id} count={g.count} onToggle={() => update({ tag: tag === g.id ? null : g.id })}>
              {g.name}
            </Chip>
          ))}
        </div>
      )}

      {notice && (
        <span className="tkp-notice" role="status">
          {notice}
        </span>
      )}

      {body}

      <div className="tkp-explainers">
        {EXPLAINERS.map((x) => (
          <Card key={x.n} className="tkp-explainer">
            <span className="tma-label">{x.n}</span>
            <span className="tkp-explainer__t">{x.t}</span>
            <span className="tkp-explainer__d">{x.d}</span>
          </Card>
        ))}
      </div>
    </main>
  )
}
