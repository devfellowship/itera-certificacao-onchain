import type { TaskHistoryEvaluation, TaskHistoryResponse } from '../lib/api'
import { AgentAvatar, Badge, Breadcrumb, ButtonLink, ModelLabel, routeOf, SelfDeclaredBadge, StatusChip, TagPill, isSelfDeclared } from '../tma/ui'
import { RunAgentCell, RunsTable, type RunRow } from '../tma/detail'
import { AppNav } from '../tma/nav/AppNav'
import './owned-task-detail.css'

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
const dateOnlyFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' })

/** The outcome word of an evaluation from its task counts (one task per evaluation here). */
function outcomeOf(evaluation: TaskHistoryEvaluation): string | null {
  const { pass, fail, invalid } = evaluation.counts
  if (pass > 0) return 'pass'
  if (fail > 0) return 'fail'
  if (invalid > 0) return 'invalid'
  return null
}

/**
 * L14a: the same runs table as the public task page. Rank by score (null last); source `run here`;
 * the CI band comes from evaluation.tests{passed,total} directly (no extra fetch); checks k/n; the
 * result dot from counts; the row links to /evaluations/{id}.
 */
function ownedRunRows(evaluations: TaskHistoryEvaluation[]): RunRow[] {
  const sorted = [...evaluations].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.createdAt.localeCompare(a.createdAt))
  return sorted.map((evaluation, i) => {
    const href = `/evaluations/${evaluation.id}`
    return {
      key: evaluation.id,
      rank: i + 1,
      agent: (
        <RunAgentCell
          href={href}
          testId="task-evaluation-link"
          name={evaluation.agent.name}
          owner={
            <>
              by {evaluation.agent.authorName} · {dateFmt.format(new Date(evaluation.createdAt))} · <StatusChip status={evaluation.status} />
              {isSelfDeclared(evaluation) && <> · <SelfDeclaredBadge testId="task-evaluation-self-declared" /></>}
            </>
          }
          avatar={
            <AgentAvatar
              id={evaluation.agent.id}
              name={evaluation.agent.name}
              src={evaluation.agent.avatarUrl}
              size={32}
              author={{ name: evaluation.agent.authorName, avatarUrl: evaluation.agent.authorProfile?.avatarUrl }}
            />
          }
        />
      ),
      model: evaluation.model?.id ? (
        <span className="tdp-evaluation__model" data-testid="task-evaluation-model" data-route={routeOf(evaluation.model.id).key}>
          <ModelLabel model={evaluation.model.id} label={evaluation.model.id} size={16} /> <span className="tdp-muted">via {routeOf(evaluation.model.id).name}</span>
        </span>
      ) : null,
      // L11: a self-declared result was run on the owner's machine and uploaded (Q4 = C: owner-only).
      source: isSelfDeclared(evaluation) ? 'imported' : 'run here',
      score: evaluation.score,
      checks: evaluation.tests.total > 0 ? evaluation.tests : null,
      outcome: outcomeOf(evaluation),
      href,
    }
  })
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

          <div data-testid="task-evaluation-history">
            <RunsTable
              rows={ownedRunRows(evaluations)}
              empty={
                <div className="tdp-empty" data-testid="task-history-empty">
                  <strong>No evaluations yet</strong>
                  <span>Run an agent on this task. Its result will appear here.</span>
                </div>
              }
            />
          </div>
        </section>
      </main>
    </div>
  )
}
