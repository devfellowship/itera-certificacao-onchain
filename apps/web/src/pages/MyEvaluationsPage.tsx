/**
 * Screen 09 — My evaluations (design: "09 My Evaluations.dc.html"; plan 20261012-itera-testmyagent-ui-refactor, U13).
 * Data: GET /evaluations?scope=all|my_agents|others (apps/api/src/evaluations/router.ts).
 * The list is every evaluation the wallet paid for; the tabs split it by who wrote the agent.
 * Row click: issued → public profile (05); anything else → the running screen (04).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, api } from '../lib/api'
import type { Agent, EvaluationListItem, EvaluationScope, EvaluationStatus, EvaluationsResponse } from '../lib/api'
import { Avatar, Badge, Button, ButtonLink, Table, TableEmpty, Tabs, type Column, type Tone } from '../tma/ui'
import './my-evaluations.css'

type Tab = 'all' | 'my_agents' | 'others'
const TAB_IDS: Tab[] = ['all', 'my_agents', 'others']

/** Every evaluation state the API can answer, as the dot + word of the status column. */
const STATUS: Record<EvaluationStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Queued', tone: 'neutral' },
  in_progress: { label: 'Running', tone: 'warning' },
  review: { label: 'Needs review', tone: 'warning' },
  issuing: { label: 'Issuing', tone: 'warning' },
  issued: { label: 'Issued', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

function evId(shortId: string) {
  return shortId.startsWith('ev_') ? shortId : `ev_${shortId}`
}

/** "0.012 SOL": 3 decimals, 5 under 0.001 so a small fee never reads as 0.000. */
export function formatFee(feeSol: string): string {
  const n = Number(feeSol)
  if (!Number.isFinite(n)) return `${feeSol} SOL`
  return `${n.toFixed(n > 0 && n < 0.001 ? 5 : 3)} SOL`
}

function formatUsd(n: number) {
  return `$${n.toFixed(2)}`
}

/** Where a row leads: the public profile of an issued evaluation, the running screen otherwise. */
export function rowTarget(e: EvaluationListItem): string {
  if (e.status === 'issued' && e.slug) return `/e/${e.slug}`
  return `/evaluations/${e.id ?? e.shortId}`
}

function absoluteUrl(url: string) {
  try {
    return new URL(url, window.location.origin).toString()
  } catch {
    return url
  }
}

function StatusCell({ status }: { status: EvaluationStatus }) {
  const s = STATUS[status] ?? { label: status, tone: 'neutral' as Tone }
  return (
    <span className="tme-status" data-testid={`status-${status}`}>
      <span className={`tme-dot tme-dot--${s.tone}`} />
      {s.label}
    </span>
  )
}

function OutcomeCell({ e }: { e: EvaluationListItem }) {
  const { pass, fail, invalid } = e.counts
  if (pass + fail + invalid > 0) {
    return (
      <span className="tme-outcome">
        {pass > 0 && <Badge tone="success">{pass} PASS</Badge>}
        {fail > 0 && <Badge tone="danger">{fail} FAIL</Badge>}
        {invalid > 0 && <Badge tone="neutral">{invalid} INVALID</Badge>}
      </span>
    )
  }
  if (e.status === 'pending') return <Badge tone="neutral">Queued…</Badge>
  if (e.status === 'cancelled' || e.status === 'failed' || e.status === 'issued') return <span className="tme-dash">—</span>
  return <span className="tme-grading">Grading…</span>
}

function ShareCell({ e }: { e: EvaluationListItem }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (e.share.kind === 'private') return <span className="tme-share tme-share__none">Private</span>
  if (e.share.kind === 'none' || !e.share.url) return <span className="tme-share tme-share__none">—</span>
  const url = absoluteUrl(e.share.url)
  const copy = async (ev: React.MouseEvent) => {
    ev.stopPropagation()
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      window.prompt('Copy this link', url)
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }
  return (
    <span className="tme-share">
      <button type="button" className="tme-share__copy" onClick={copy} data-testid="copy-link">
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </span>
  )
}

const COLUMNS: Column<EvaluationListItem>[] = [
  {
    key: 'agent',
    header: 'Agent',
    width: 'minmax(0,1fr)',
    render: (e) => (
      <span className="tme-agent">
        <Avatar initials={e.agent.initials} size={40} />
        <span className="tme-agent__text">
          <span>
            <Link to={rowTarget(e)} className="tme-agent__name" onClick={(ev) => ev.stopPropagation()}>
              {e.agent.name}
            </Link>{' '}
            <span className="tme-agent__by">by {e.agent.isMine ? 'you' : e.agent.authorName}</span>
          </span>
          <span className="tme-agent__meta" title={e.feeUsd != null ? `Fee ${formatFee(e.feeSol)} ≈ ${formatUsd(e.feeUsd)}` : undefined}>
            {evId(e.shortId)} · {dateFmt.format(new Date(e.createdAt))} · {formatFee(e.feeSol)}
          </span>
        </span>
      </span>
    ),
  },
  {
    key: 'tasks',
    header: 'Tasks',
    width: '260px',
    render: (e) => (
      <span className="tme-tasks" title={e.tasks.map((t) => t.name).join('\n')}>
        {e.tasks[0] && <span className="tme-task">{e.tasks[0].name}</span>}
        {e.tasks.length > 1 && <span className="tme-more">+{e.tasks.length - 1}</span>}
      </span>
    ),
  },
  { key: 'outcome', header: 'Outcome', width: '150px', render: (e) => <OutcomeCell e={e} /> },
  {
    key: 'score',
    header: 'Score',
    width: '72px',
    align: 'right',
    render: (e) => (e.score != null ? <span className="tme-score">{e.score.toFixed(1)}</span> : <span className="tme-score tme-score--none">—</span>),
  },
  { key: 'status', header: 'Status', width: '130px', render: (e) => <StatusCell status={e.status} /> },
  { key: 'share', header: 'Share', width: '110px', align: 'right', render: (e) => <ShareCell e={e} /> },
]

/** Loading state: the same grid, six rows of placeholders. */
const SKELETON_COLUMNS: Column<number>[] = [
  {
    key: 'agent',
    header: 'Agent',
    width: 'minmax(0,1fr)',
    render: () => (
      <span className="tme-skel-agent">
        <span className="tme-skel tme-skel--avatar" />
        <span className="tme-skel-agent__lines">
          <span className="tme-skel" style={{ width: '45%' }} />
          <span className="tme-skel" style={{ width: '70%', height: 10 }} />
        </span>
      </span>
    ),
  },
  { key: 'tasks', header: 'Tasks', width: '260px', render: () => <span className="tme-skel" style={{ width: 180, height: 24 }} /> },
  { key: 'outcome', header: 'Outcome', width: '150px', render: () => <span className="tme-skel" style={{ width: 90, height: 20 }} /> },
  { key: 'score', header: 'Score', width: '72px', align: 'right', render: () => <span className="tme-skel" style={{ width: 36, height: 18 }} /> },
  { key: 'status', header: 'Status', width: '130px', render: () => <span className="tme-skel" style={{ width: 70 }} /> },
  { key: 'share', header: 'Share', width: '110px', align: 'right', render: () => <span className="tme-skel" style={{ width: 64 }} /> },
]
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5]

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: EvaluationsResponse }

export function MyEvaluationsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = TAB_IDS.includes(raw as Tab) ? (raw as Tab) : 'all'
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // Counts and the spent total cover every evaluation, whatever the tab: keep them while a tab loads.
  const [totals, setTotals] = useState<EvaluationsResponse['totals'] | null>(null)
  const [myAgents, setMyAgents] = useState<Agent[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoad({ state: 'loading' })
    api
      .evaluations(tab as EvaluationScope)
      .then((data) => {
        if (cancelled) return
        setTotals(data.totals)
        setLoad({ state: 'ready', data })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoad({ state: 'error', message: err instanceof ApiError || err instanceof Error ? err.message : 'Request failed' })
      })
    return () => {
      cancelled = true
    }
  }, [tab, attempt])

  // "New evaluation" → 03 for the user's agent, or 02 when the user has none yet.
  useEffect(() => {
    let cancelled = false
    api
      .agents()
      .then((r) => !cancelled && setMyAgents(r.agents))
      .catch(() => !cancelled && setMyAgents(null))
    return () => {
      cancelled = true
    }
  }, [])
  const newEvaluationHref = useMemo(() => {
    if (myAgents == null) return '/agents'
    return myAgents.length > 0 ? `/agents/${myAgents[0].id}/evaluate` : '/agents/new'
  }, [myAgents])

  const setTab = useCallback(
    (id: Tab) => {
      const next = new URLSearchParams(params)
      if (id === 'all') next.delete('tab')
      else next.set('tab', id)
      setParams(next, { replace: true })
    },
    [params, setParams],
  )

  const tabs = [
    { id: 'all' as const, label: 'All', count: totals?.counts.all },
    { id: 'my_agents' as const, label: 'On my agents', count: totals?.counts.myAgents },
    { id: 'others' as const, label: 'On other agents', count: totals?.counts.others },
  ]

  let body
  if (load.state === 'loading') {
    body = (
      <div aria-busy="true" data-testid="evaluations-loading">
        <Table columns={SKELETON_COLUMNS} rows={SKELETON_ROWS} rowKey={(r) => String(r)} testId="evaluations-skeleton" />
      </div>
    )
  } else if (load.state === 'error') {
    body = (
      <div className="tma-table" data-testid="evaluations-error" role="alert">
        <TableEmpty title="Could not load your evaluations">
          <span className="tme-empty-text">{load.message}</span>
          <Button variant="secondary" size={32} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </TableEmpty>
      </div>
    )
  } else {
    const rows = load.data.evaluations
    const none = {
      all: { title: 'No evaluations yet', text: 'Every run you pay for shows up here, with its score and a link to share.', cta: 'Choose an agent to evaluate', to: newEvaluationHref },
      my_agents: { title: 'No evaluations on your agents yet', text: 'Evaluations you paid for on agents you wrote appear here.', cta: 'Evaluate one of your agents', to: newEvaluationHref },
      others: { title: 'No evaluations on other agents yet', text: 'Rank other agents on tasks you care about; the runs you pay for appear here.', cta: 'Browse agents', to: '/agents' },
    }[tab]
    body = (
      <div className="tme" data-testid="evaluations-table-wrap">
        <Table
          columns={COLUMNS}
          rows={rows}
          rowKey={(e) => e.id ?? e.shortId}
          onRowClick={(e) => navigate(rowTarget(e))}
          testId="evaluations-table"
          empty={
            <TableEmpty title={none.title}>
              <span className="tme-empty-text">{none.text}</span>
              <Link to={none.to} className="tma-body-sm">
                {none.cta} →
              </Link>
            </TableEmpty>
          }
        />
      </div>
    )
  }

  return (
    <main className="tma-page tme" data-testid="my-evaluations">
      <div className="tme-head">
        <div className="tme-head__text">
          <h1 className="tma-h1">My evaluations</h1>
          <span className="tme-sub">Every run you paid for, on your agents or anyone's.</span>
        </div>
        <ButtonLink variant="primary" href={newEvaluationHref} data-testid="new-evaluation">
          New evaluation
        </ButtonLink>
      </div>

      <div className="tme-tabsrow">
        <Tabs items={tabs} value={tab} onChange={setTab} />
        {totals && (
          <span className="tme-spent" data-testid="evaluations-spent">
            Spent {formatFee(totals.spentSol)} ≈ {formatUsd(totals.usd)}
          </span>
        )}
      </div>

      {body}

      <span className="tme-note">Evaluations on private tasks stay private. Only evaluations on public tasks get a shareable profile.</span>
    </main>
  )
}
