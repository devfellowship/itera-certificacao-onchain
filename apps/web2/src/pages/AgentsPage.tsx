/**
 * Screen 01 Agents (design: "01 Agents.dc.html"). Directory and ranking in one page.
 * Data: GET /agents/ranking (own agents always, other wallets' listed agents with an issued result),
 * GET /tasks + GET /tags through the Task Filter. URL state: /agents?tasks=a,b&q=&tab=all|mine.
 * Search and the All/Mine tab filter the loaded rows; only the task selection calls the API again.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import type { RankingResponse, RankingRow } from '../lib/api'
import { HOSTED_RUNS_ENABLED } from '../config'
import { AgentAvatar, Badge, Button, ButtonLink, ModelLabel, RemovableChip, SearchInput, SectionLabel, StatusChip, Table, TableEmpty, Tabs, isLocalAgent, isSelfDeclared, type Column } from '../tma/ui'
import { findTask, TaskFilter, TaskName, useTaskCatalog } from '../tma/task-filter'
import { relativeTime } from './agents/format'
import { LocalAgentsSection } from './agents/LocalAgentsSection'
import './agents/agents.css'

type Tab = 'all' | 'mine'

type RankingState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: RankingResponse }

function useRanking(taskIds: string[]) {
  const [state, setState] = useState<RankingState>({ status: 'loading' })
  const [stale, setStale] = useState(false)
  const [nonce, setNonce] = useState(0)
  const key = taskIds.join(',')
  useEffect(() => {
    let alive = true
    setStale(true)
    api.ranking({ taskIds: key ? key.split(',') : [] }).then(
      (data) => {
        if (!alive) return
        setState({ status: 'ready', data })
        setStale(false)
      },
      (e: unknown) => {
        if (!alive) return
        setState({ status: 'error', message: e instanceof ApiError || e instanceof Error ? e.message : 'Could not load agents.' })
        setStale(false)
      },
    )
    return () => {
      alive = false
    }
  }, [key, nonce])
  return { state, stale, retry: () => setNonce((n) => n + 1) }
}

function matches(a: RankingRow, needle: string) {
  return !needle || [a.name, a.authorName, a.description ?? '', a.modelLabel].join(' ').toLowerCase().includes(needle)
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function FilterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
    </svg>
  )
}

export function AgentsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'mine' ? 'mine' : 'all'
  const q = params.get('q') ?? ''
  const rawIds = params.get('tasks') ?? ''
  const selIds = useMemo(() => (rawIds ? rawIds.split(',').filter(Boolean) : []), [rawIds])
  const [filterOpen, setFilterOpen] = useState(false)

  const update = useCallback(
    (patch: { tab?: Tab; q?: string; tasks?: string[] }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (patch.tab !== undefined) patch.tab === 'mine' ? next.set('tab', 'mine') : next.delete('tab')
          if (patch.q !== undefined) patch.q ? next.set('q', patch.q) : next.delete('q')
          if (patch.tasks !== undefined) patch.tasks.length ? next.set('tasks', patch.tasks.join(',')) : next.delete('tasks')
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  // Task ids in the URL may be slugs (links from My tasks). Normalize to catalog ids; drop unknown ones.
  const catalog = useTaskCatalog()
  useEffect(() => {
    if (catalog.status !== 'ready' || selIds.length === 0) return
    const norm = selIds.map((s) => findTask(catalog.catalog.tasks, s)?.id).filter((x): x is string => !!x)
    const dedup = [...new Set(norm)]
    if (dedup.join(',') !== selIds.join(',')) update({ tasks: dedup })
  }, [catalog, selIds, update])

  const { state, stale, retry } = useRanking(selIds)
  const n = selIds.length
  const tasksOf = (ids: string[]) => (catalog.status === 'ready' ? ids.map((id) => ({ id, task: findTask(catalog.catalog.tasks, id) })) : ids.map((id) => ({ id, task: undefined })))

  const all = state.status === 'ready' ? state.data.rows : []
  const needle = q.trim().toLowerCase()
  // Q4 = C: the ranking is hosted-only. A local agent or a self-declared row never ranks, whatever the API sends.
  const rows = useMemo(() => all.filter((a) => !isLocalAgent(a) && !isSelfDeclared(a) && (tab === 'all' || a.isMine) && matches(a, needle)), [all, tab, needle])
  const ranks = useMemo(() => {
    let r = 0
    return new Map(rows.map((a) => [a.id, a.score != null ? ++r : null]))
  }, [rows])

  const goRun = (a: RankingRow) => navigate(`/agents/${encodeURIComponent(a.id)}/evaluate?tasks=${selIds.join(',')}`)

  const columns: Column<RankingRow>[] = [
    {
      key: 'rank',
      header: '#',
      width: '40px',
      render: (a) => {
        const r = ranks.get(a.id) ?? null
        return <span className={r != null && r <= 3 ? 'agents-rank agents-rank--top' : 'agents-rank'}>{r == null ? '—' : String(r).padStart(2, '0')}</span>
      },
    },
    {
      key: 'agent',
      header: 'Agent',
      width: 'minmax(0,1fr)',
      render: (a) => (
        <div className="agents-agent">
          <AgentAvatar size={44} id={a.id} name={a.name} src={a.avatarUrl} author={{ name: a.authorName, avatarUrl: a.authorProfile?.avatarUrl }} />
          <div className="agents-agent__text">
            <div className="agents-agent__line">
              <span className="agents-agent__name">{a.name}</span>
              <span className="agents-agent__by">
                by <b>{a.isMine ? 'you' : a.authorName}</b> · {relativeTime(a.when)}
              </span>
              {a.draft && <StatusChip status="draft" />}
              {a.selfEvaluated && (
                <span title="A counted result is on a task this agent's owner wrote (same account or same GitHub account).">
                  <Badge tone="warning" testId="row-self-evaluated">
                    Self-evaluated
                  </Badge>
                </span>
              )}
            </div>
            <span className="agents-agent__desc">{a.description}</span>
          </div>
        </div>
      ),
    },
    { key: 'model', header: 'Model', width: '170px', render: (a) => <ModelLabel className="agents-model" model={a.model} label={a.modelLabel} size={20} /> },
    {
      key: 'cov',
      header: n ? 'Coverage' : 'Evaluated on',
      width: '140px',
      render: (a) => {
        if (n) {
          const cov = a.coverage
          if (!cov) return null
          return (
            <div className="agents-cov">
              <div className="agents-cov__dots">
                {cov.perTask.map((has, i) => (
                  <span key={i} className={has ? 'agents-cov__dot agents-cov__dot--on' : 'agents-cov__dot'} />
                ))}
              </div>
              <span className="agents-cov__text">
                {cov.k} / {cov.n}
              </span>
            </div>
          )
        }
        return <span className="agents-cov__text">{a.taskCount ? plural(a.taskCount, 'task') : '—'}</span>
      },
    },
    {
      key: 'score',
      header: 'Score',
      width: '150px',
      align: 'right',
      render: (a) => {
        const has = a.score != null
        // L15b: no hosted start while web2 = ingested only (Tainan TG 23889); the note names the local runner.
        const canRun = HOSTED_RUNS_ENABLED && n > 0 && a.coverage?.k === 0
        return (
          <div className="agents-score">
            {has && (
              <>
                <span className="agents-score__track">
                  <span className="agents-score__fill" style={{ width: `${a.score}%` }} />
                </span>
                <span className="agents-score__value" data-testid="agent-score">
                  {a.score!.toFixed(1)}
                </span>
              </>
            )}
            {canRun && (
              <Button
                variant="secondary-dark"
                size={30}
                data-testid="agent-run"
                onClick={(e) => {
                  e.stopPropagation()
                  goRun(a)
                }}
              >
                <span>
                  Run · <span className="agents-run-cost">Free · your key</span>
                </span>
              </Button>
            )}
            {n === 0 && !has && <span className="agents-score__none">Not run</span>}
          </div>
        )
      },
    },
  ]

  const note = n
    ? `Score on selected tasks = mean of per-task scores you can see. ${HOSTED_RUNS_ENABLED ? 'Run missing tasks for free with your OpenRouter key.' : 'Run missing tasks on your machine with the tma local runner.'}`
    : 'Score = latest verified evaluation: hidden tests passed, weighted by task difficulty, 0–100.'

  let body: React.ReactNode
  if (state.status === 'loading') {
    body = [0, 1, 2, 3, 4, 5].map((i) => (
      <div key={i} className="tma-table__row" data-testid="agents-skeleton" style={{ gridTemplateColumns: '40px minmax(0,1fr) 170px 140px 150px', gap: 20 }}>
        <span className="agents-skel" style={{ width: 16 }} />
        <span className="agents-skel" style={{ width: `${40 + ((i * 17) % 30)}%` }} />
        <span className="agents-skel" style={{ width: 90 }} />
        <span className="agents-skel" style={{ width: 60 }} />
        <span className="agents-skel" style={{ width: 70, justifySelf: 'end' }} />
      </div>
    ))
  } else if (state.status === 'error') {
    body = (
      <div role="alert">
        <TableEmpty title="Could not load agents.">
          <span className="tma-body-sm tma-muted">{state.message}</span>
          <Button variant="text" onClick={retry}>
            Try again
          </Button>
        </TableEmpty>
      </div>
    )
  } else {
    body = (
      <TableEmpty title="No agents match these filters.">
        <Button variant="text" onClick={() => update({ tasks: [], q: '' })}>
          Clear filters
        </Button>
      </TableEmpty>
    )
  }

  const showTable = state.status === 'ready' && rows.length > 0

  return (
    <main className="tma-page" data-testid="agents-page">
      <div className="agents-head">
        <div className="agents-head__titles">
          <h1 className="tma-h1">Agents</h1>
          <span className="agents-head__sub">Ranked by verified evaluations. Pick tasks to rank them on what you need.</span>
        </div>
        <ButtonLink variant="primary" href="/agents/new">
          Add agent
        </ButtonLink>
      </div>

      <div className="agents-controls">
        <Tabs<Tab>
          items={[
            { id: 'all', label: 'All', count: all.length },
            { id: 'mine', label: 'Mine', count: all.filter((a) => a.isMine).length },
          ]}
          value={tab}
          onChange={(t) => update({ tab: t })}
        />
        <div className="agents-controls__right">
          <SearchInput width={280} value={q} onChange={(e) => update({ q: e.target.value })} placeholder="Search agents, models" aria-label="Search agents, models" />
          <button type="button" className="agents-tasks-btn" data-active={filterOpen || n > 0} data-testid="tasks-filter-button" onClick={() => setFilterOpen(true)}>
            <FilterIcon />
            <span>Tasks</span>
            <span className="agents-tasks-btn__count">{n ? n : 'Any'}</span>
          </button>
        </div>
      </div>

      {n > 0 && (
        <div className="agents-strip" data-testid="ranked-on">
          <div className="agents-strip__chips">
            <SectionLabel>Ranked on</SectionLabel>
            {tasksOf(selIds).map(({ id, task }) => (
              <RemovableChip key={id} onRemove={() => update({ tasks: selIds.filter((x) => x !== id) })} removeLabel={`Remove ${task?.name ?? id}`}>
                <TaskName name={task?.name ?? id} taskId={task?.id ?? id} slug={task?.slug} />
              </RemovableChip>
            ))}
            <Button variant="text" onClick={() => setFilterOpen(true)} style={{ padding: '0 4px' }}>
              Edit
            </Button>
          </div>
          <Button variant="muted" onClick={() => update({ tasks: [] })}>
            Clear
          </Button>
        </div>
      )}

      <div className={['agents-rows', stale && state.status === 'ready' && 'agents-loading-dim'].filter(Boolean).join(' ')}>
        {showTable ? (
          <Table<RankingRow>
            testId="agents-table"
            columns={columns}
            rows={rows}
            rowKey={(a) => a.id}
            onRowClick={(a) => navigate(`/agents/${encodeURIComponent(a.id)}`)}
          />
        ) : (
          <div className="tma-table">
            <div className="tma-table__head" style={{ gridTemplateColumns: '40px minmax(0,1fr) 170px 140px 150px', gap: 20 }}>
              <span>#</span>
              <span>Agent</span>
              <span>Model</span>
              <span>{n ? 'Coverage' : 'Evaluated on'}</span>
              <span className="tma-table__num">Score</span>
            </div>
            {body}
          </div>
        )}
      </div>
      <span className="agents-note">{note}</span>
      <LocalAgentsSection />

      {filterOpen && <TaskFilter variant="modal" mode="rank" selected={selIds} onApply={(ids) => update({ tasks: ids })} onClose={() => setFilterOpen(false)} />}
    </main>
  )
}
