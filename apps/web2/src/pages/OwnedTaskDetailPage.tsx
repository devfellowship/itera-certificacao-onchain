import { Link } from 'react-router-dom'
import type { TaskHistoryEvaluation, TaskHistoryResponse } from '../lib/api'
import { AgentAvatar, Badge, Breadcrumb, ButtonLink, ModelLabel, routeOf, StatusChip, TagPill } from '../tma/ui'
import { AppNav } from '../tma/nav/AppNav'
import './owned-task-detail.css'

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
const dateOnlyFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' })

function EvaluationOutcome({ evaluation }: { evaluation: TaskHistoryEvaluation }) {
  const { pass, fail, invalid } = evaluation.counts
  if (pass + fail + invalid === 0) return <span className="tdp-muted">Task result unavailable</span>
  return (
    <span className="tdp-outcomes">
      {pass > 0 && <Badge tone="success">{pass} task passed</Badge>}
      {fail > 0 && <Badge tone="danger">{fail} task failed</Badge>}
      {invalid > 0 && <Badge tone="neutral">{invalid} invalid result</Badge>}
    </span>
  )
}

function EvaluationRow({ evaluation }: { evaluation: TaskHistoryEvaluation }) {
  return (
    <Link className="tdp-evaluation" to={`/evaluations/${evaluation.id}`} data-testid="task-evaluation-link">
      <span className="tdp-evaluation__agent">
        <AgentAvatar
          id={evaluation.agent.id}
          name={evaluation.agent.name}
          src={evaluation.agent.avatarUrl}
          size={40}
          author={{ name: evaluation.agent.authorName, avatarUrl: evaluation.agent.authorProfile?.avatarUrl }}
        />
        <span className="tdp-evaluation__agent-copy">
          <strong>{evaluation.agent.name}</strong>
          <span>by {evaluation.agent.authorName}</span>
          {evaluation.model?.id && (
            <span className="tdp-evaluation__model" data-testid="task-evaluation-model" data-route={routeOf(evaluation.model.id).key}>
              <ModelLabel model={evaluation.model.id} label={evaluation.model.id} size={16} /> <span className="tdp-muted">via {routeOf(evaluation.model.id).name}</span>
            </span>
          )}
        </span>
      </span>
      <span className="tdp-evaluation__date">
        <span>{dateFmt.format(new Date(evaluation.createdAt))}</span>
      </span>
      <EvaluationOutcome evaluation={evaluation} />
      <span className="tdp-evaluation__tests">
        {evaluation.tests.total > 0 ? `${evaluation.tests.passed}/${evaluation.tests.total}` : '—'}
      </span>
      <span className="tdp-evaluation__score" data-testid="task-evaluation-score">
        {evaluation.score == null ? <small>No score</small> : evaluation.score.toFixed(1)}
      </span>
      <span className="tdp-evaluation__status"><StatusChip status={evaluation.status} dot /></span>
      <span className="tdp-evaluation__arrow" aria-hidden="true">→</span>
    </Link>
  )
}

export function OwnedTaskDetailPage({ data }: { data: TaskHistoryResponse }) {
  const { task, evaluations, summary } = data
  const version = task.latestVersion
  return (
    <div className="tma-app tdp-app">
      <AppNav />
      <main className="tma-page tdp" data-testid="owned-task-details">
        <Breadcrumb items={[{ label: 'Tasks', to: '/tasks?tab=mine' }, { label: task.name }]} />

        <section className="tdp-head">
          <div className="tdp-head__copy">
            <span className="tma-label">TASK DETAILS</span>
            <div className="tdp-head__title">
              <h1 className="tma-h1" data-testid="task-detail-title">{task.name}</h1>
              <StatusChip status={task.status} />
              <Badge tone="neutral">{task.visibility}</Badge>
            </div>
            <p>{task.description}</p>
            <div className="tdp-tags">
              {task.tags.map((tag) => <TagPill key={tag.id}>{tag.name}</TagPill>)}
              {(task.labels ?? []).map((label) => <TagPill key={label}>{label}</TagPill>)}
            </div>
          </div>
          <div className="tdp-head__actions">
            {task.kind === 'user' && <ButtonLink href={`/tasks/${encodeURIComponent(task.id)}/edit`} variant="secondary">Edit task</ButtonLink>}
            <ButtonLink href={`/agents?tasks=${encodeURIComponent(task.id)}`} variant="primary">Rank agents</ButtonLink>
          </div>
        </section>

        <section className="tdp-facts" aria-label="Task facts">
          <div><span>Evaluations</span><strong>{summary.evaluations}</strong></div>
          <div><span>Agents</span><strong>{summary.agents}</strong></div>
          <div><span>Version</span><strong>{version ? `v${version.version}` : '—'}</strong></div>
          <div><span>Source</span><strong>{version?.source ?? task.source ?? '—'}</strong></div>
          <div><span>Task pack</span><strong title={version?.packId ? `${version.packId}@${version.packVersion ?? version.version}` : undefined}>{version?.packId ? `${version.packId}@${version.packVersion ?? version.version}` : '—'}</strong></div>
          <div className="tdp-facts__source"><span>Files</span>{version?.sourceLink ? <a href={`https://github.com/${version.sourceLink.repo}/tree/${version.sourceLink.commit}/${version.sourceLink.path}`} target="_blank" rel="noreferrer" data-testid="task-source-link">View task source ↗</a> : <strong>Unavailable</strong>}</div>
          <div><span>Updated</span><strong>{dateOnlyFmt.format(new Date(task.updatedAt))}</strong></div>
        </section>

        <section className="tdp-history">
          <header className="tdp-history__head">
            <div>
              <span className="tma-label">EVALUATION HISTORY</span>
              <h2 className="tma-h2">Runs on this task</h2>
            </div>
            <span>{summary.evaluations} evaluation{summary.evaluations === 1 ? '' : 's'}</span>
          </header>

          <div className="tdp-history__card" data-testid="task-evaluation-history">
            <div className="tdp-evaluation tdp-evaluation--head" aria-hidden="true">
              <span>Agent</span><span>Date</span><span>Outcome</span><span>Tests</span><span>Score</span><span>Status</span><span />
            </div>
            {evaluations.map((evaluation) => <EvaluationRow key={evaluation.id} evaluation={evaluation} />)}
            {evaluations.length === 0 && (
              <div className="tdp-empty" data-testid="task-history-empty">
                <strong>No evaluations yet</strong>
                <span>Run an agent on this task. Its result will appear here.</span>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
