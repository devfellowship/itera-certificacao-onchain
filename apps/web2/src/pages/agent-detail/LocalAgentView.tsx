/**
 * /agents/:aid for a LOCAL agent (plan 20261026-tma-local-runner-and-self-declared-results, L11; Q4 = C).
 * GET /agents/:id/profile answers 404 for a local agent (it never ranks and has no public evidence), so the
 * owner reads GET /agents/:id and this view shows: identity, model (logo from the declared provider key),
 * route, harness, the tma CLI steps, and the owner's self-declared evaluations of this agent
 * (GET /evaluations?scope=my_agents, filtered by agent id). Every row carries the Self-declared badge.
 */
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import type { Agent, EvaluationListItem } from '../../lib/api'
import { AgentAvatar, AgentOriginPill, Badge, Breadcrumb, Button, Card, ModelLabel, SelfDeclaredBadge, StatusChip, Table, TableEmpty, isSelfDeclared, routeOfAgent, type Column } from '../../tma/ui'
import { TaskName } from '../../tma/task-filter'
import { TmaCliSteps } from './TmaCliSteps'
import './local-agent-view.css'

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

type Results = { state: 'loading' } | { state: 'error' } | { state: 'ready'; rows: EvaluationListItem[] }

function Outcome({ e }: { e: EvaluationListItem }) {
  const { pass, fail, invalid } = e.counts
  if (pass + fail + invalid === 0) return <span className="lav-dash">—</span>
  return (
    <span className="lav-outcome">
      {pass > 0 && <Badge tone="success">{pass} PASS</Badge>}
      {fail > 0 && <Badge tone="danger">{fail} FAIL</Badge>}
      {invalid > 0 && <Badge tone="neutral">{invalid} INVALID</Badge>}
    </span>
  )
}

const COLUMNS: Column<EvaluationListItem>[] = [
  {
    key: 'task',
    header: 'Task',
    width: 'minmax(0,1fr)',
    render: (e) => (
      <span className="lav-task">
        <span className="lav-task__line">
          {e.tasks[0] ? <TaskName className="lav-task__name" name={e.tasks[0].name} taskId={e.tasks[0].id} /> : <span className="lav-task__name">Evaluation</span>}
          {e.tasks.length > 1 && <span className="lav-muted">+{e.tasks.length - 1}</span>}
        </span>
        <span className="lav-task__meta">
          {e.shortId.startsWith('ev_') ? e.shortId : `ev_${e.shortId}`} · {dateFmt.format(new Date(e.createdAt))}
          {isSelfDeclared(e) && <SelfDeclaredBadge testId="row-self-declared" />}
        </span>
      </span>
    ),
  },
  { key: 'outcome', header: 'Outcome', width: '150px', render: (e) => <Outcome e={e} /> },
  { key: 'score', header: 'Score', width: '72px', align: 'right', render: (e) => <span className="lav-score">{e.score == null ? '—' : e.score.toFixed(1)}</span> },
  { key: 'status', header: 'Status', width: '120px', render: (e) => <StatusChip status={e.status} dot /> },
]

export function LocalAgentView({ agent }: { agent: Agent }) {
  const navigate = useNavigate()
  const route = routeOfAgent(agent)
  const [results, setResults] = useState<Results>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setResults({ state: 'loading' })
    api
      .evaluations('my_agents')
      .then((r) => alive && setResults({ state: 'ready', rows: r.evaluations.filter((e) => e.agent.id === agent.id) }))
      .catch(() => alive && setResults({ state: 'error' }))
    return () => {
      alive = false
    }
  }, [agent.id, attempt])

  return (
    <main className="tma-page lav" data-testid="local-agent-detail" data-agent={agent.id}>
      <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: agent.name }]} />

      <div className="lav-identity">
        <AgentAvatar id={agent.id} name={agent.name} src={typeof agent.avatarUrl === 'string' ? agent.avatarUrl : null} size={72} />
        <div className="lav-identity__text">
          <div className="lav-identity__line">
            <h1 className="lav-h1" data-testid="agent-name">
              {agent.name}
            </h1>
            <AgentOriginPill connector={agent.connector} testId="agent-origin-pill" />
            {agent.visibility && <StatusChip status={agent.visibility} />}
          </div>
          <span className="lav-meta" data-testid="local-agent-model">
            <ModelLabel model={agent.model} provider={agent.providerKey} label={agent.model ?? '—'} size={20} />
            <span data-testid="agent-model-route" data-route={route.key}>
              via {route.name}
            </span>
            {agent.harness && (
              <span className="lav-meta__harness" data-testid="agent-harness">
                · harness <span className="lav-mono">{agent.harness}</span>
              </span>
            )}
          </span>
          {agent.description && <p className="lav-desc">{agent.description}</p>}
        </div>
      </div>

      <div className="lav-grid">
        <Card className="lav-section" data-testid="self-declared-results">
          <div className="lav-section__head">
            <span className="lav-section__title">Your self-declared results</span>
            <span className="lav-section__sub">Run on your machine. TestMyAgent did not run or verify them. Visible only to you.</span>
          </div>
          {results.state === 'loading' ? (
            <div className="lav-state" aria-busy="true" data-testid="self-declared-results-loading">
              <span className="lav-skel" />
            </div>
          ) : results.state === 'error' ? (
            <div className="lav-state" role="alert" data-testid="self-declared-results-error">
              <span className="lav-muted">Could not load your results.</span>
              <Button variant="secondary" size={32} onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : (
            <Table
              columns={COLUMNS}
              rows={results.rows}
              rowKey={(e) => e.id}
              gap={16}
              testId="self-declared-table"
              onRowClick={(e) => navigate(`/evaluations/${encodeURIComponent(e.id ?? e.shortId)}`)}
              empty={
                <TableEmpty title="No results yet">
                  <span className="lav-muted">Run the agent with the tma CLI, then upload result.json. The steps are on the right.</span>
                </TableEmpty>
              }
            />
          )}
        </Card>

        <aside className="lav-rail">
          <Card pad className="lav-run" data-testid="run-locally-card">
            <span className="lav-run__title">Run {agent.name} on your machine</span>
            <TmaCliSteps agent={agent} />
          </Card>
          <Link to="/evaluations" className="lav-link">
            All my evaluations →
          </Link>
        </aside>
      </div>
    </main>
  )
}
