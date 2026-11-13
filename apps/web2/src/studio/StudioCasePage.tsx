/**
 * S4 Test case (plan 20261112-tma-c5-studio-area-web2, task C5-T3), route /studio/cases/:caseId. READ ONLY (ADR-5):
 * no Save, no Run; the copy command is the only action.
 * Data: GET /eval-cases/:id (the case, its graders, its variants with counts) and GET /eval-runs?case=<id> (the
 * uploaded runs). Each run links to its canonical page /evaluations/:eid/runs/:runId, each evaluation to
 * /evaluations/:eid, the task to /tasks/:slug.
 * The task summary shows Before and Expected only (Q-T16 = A); S4 never shows an outcome.
 * Environment: the case's environment is covered by its manifest digest; the API does not store the environment
 * itself (only digests, plan C4 ADR-3), so S4 shows the digest and points to the task page instead of
 * EnvironmentCard.
 */
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { EvalCaseDetail, EvalRun, EvalRunsResponse } from '../lib/api/types'
import { Badge, Card, CardHeader, KeyValue, TagPill } from '../tma/ui'
import { CopyCommand } from './CopyCommand'
import { caseCommands } from './eval-command'
import { studioHref } from './links'
import { changeText, evaluationHref, evaluationIdsOf, runHref, sha12, statusTone } from './runs'
import { splitUseCaseKey } from './use-case'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

type Data = { detail: EvalCaseDetail; runs: EvalRunsResponse }

export function StudioCasePage() {
  const { caseId = '' } = useParams()
  const loaded = useStudioLoad<Data>(
    () => Promise.all([api.evalCase(caseId), api.evalRuns({ case: caseId })]).then(([detail, runs]) => ({ detail, runs })),
    [caseId],
  )
  return (
    <main className="tma-page" data-testid="studio-case-page">
      <p className="tma-body-sm">
        <Link to="/studio" data-testid="studio-back">
          Studio
        </Link>{' '}
        / test case
      </p>
      {loaded.state === 'loading' && (
        <Card pad data-testid="studio-loading">
          <span className="tma-body-sm tma-muted">Loading the test case…</span>
        </Card>
      )}
      {loaded.state === 'error' && (
        <Card pad data-testid="studio-empty">
          <span className="tma-label">{loaded.status === 404 ? 'Test case not found' : 'No test case to show'}</span>
          <p className="tma-body-sm tma-muted" data-testid="studio-load-error">
            {loadErrorText(loaded.status)}
          </p>
          <CaseCommand detail={null} runs={[]} />
        </Card>
      )}
      {loaded.state === 'ok' && <CaseView detail={loaded.data.detail} runs={loaded.data.runs} />}
    </main>
  )
}

function CaseCommand({ detail, runs }: { detail: EvalCaseDetail | null; runs: EvalRun[] }) {
  // The agent of the case's uploads (the baseline's first), for --agent; a placeholder when there is none.
  const baselineRun = runs.find((r) => r.variant.isBaseline && r.agentId) ?? runs.find((r) => r.agentId)
  const kase = detail ?? { caseKey: '<case key>', useCaseKey: '<type>/<subtype>', mode: 'replay' }
  return (
    <CopyCommand
      title="Test a variant on this case (on your host)"
      testId="case-copy-command"
      command={caseCommands(kase, { agentId: baselineRun?.agentId ?? null, variant: null }).join('\n')}
    />
  )
}

function CaseView({ detail, runs }: { detail: EvalCaseDetail; runs: EvalRunsResponse }) {
  const { type, subtype } = splitUseCaseKey(detail.useCaseKey)
  const agentId = runs.runs.find((r) => r.agentId)?.agentId ?? null
  return (
    <>
      <div className="stu-head">
        <h1 className="tma-h1 tma-mono" data-testid="case-key">
          {detail.caseKey}
        </h1>
        <div className="stu-tags" data-testid="case-use-case">
          <TagPill>{type}</TagPill>
          {subtype && <TagPill>{subtype}</TagPill>}
          <Badge tone="neutral" testId="case-mode">
            {detail.mode === 'trace_review' ? 'trace review' : 'replay'}
          </Badge>
        </div>
      </div>

      <Card pad data-task-summary data-testid="case-task-summary">
        <span className="tma-label">Task summary</span>
        <dl className="stu-summary">
          <dt>Before</dt>
          <dd data-testid="summary-before">{detail.taskSummary?.before ?? '—'}</dd>
          <dt>Expected</dt>
          <dd data-testid="summary-expected">{detail.taskSummary?.expected ?? '—'}</dd>
        </dl>
      </Card>

      <Card>
        <CardHeader title="Case" />
        <div className="stu-pad">
          <KeyValue
            rows={[
              { key: 'Use case', value: <span className="tma-mono">{detail.useCaseKey}</span> },
              { key: 'Mode', value: detail.mode },
              {
                key: 'Task',
                testId: 'case-task',
                value: detail.taskSlug ? (
                  <Link to={`/tasks/${encodeURIComponent(detail.taskSlug)}`} data-testid="case-task-link">
                    {detail.taskSlug}
                  </Link>
                ) : (
                  'no task'
                ),
              },
              {
                key: 'Environment',
                testId: 'case-environment',
                value: (
                  <span className="tma-body-sm">
                    In the case manifest <span className="tma-mono">{sha12(detail.manifestSha256)}</span>
                    {detail.taskSlug ? ' (the task page shows the task environment).' : '.'}
                  </span>
                ),
              },
              { key: 'Origin pin', value: <span className="tma-mono">{sha12(detail.originPinSha256)}</span> },
              {
                key: 'Graders',
                testId: 'case-graders',
                value: detail.graders.length ? (
                  <span className="stu-tags">
                    {detail.graders.map((g) => (
                      <span key={`${g.id}@${g.semver}`} className="tma-mono" data-testid="case-grader" title={g.kind}>
                        {g.id}@{g.semver}
                      </span>
                    ))}
                  </span>
                ) : (
                  'no grading uploaded yet'
                ),
              },
            ]}
          />
        </div>
      </Card>

      <Card data-testid="case-variants">
        <CardHeader title="Variants" meta={`${detail.variants.length} on this case`} />
        {detail.variants.length === 0 ? (
          <p className="stu-pad tma-body-sm tma-muted" data-testid="case-variants-empty">
            No variant has uploaded results on this case yet.
          </p>
        ) : (
          detail.variants.map((v) => {
            const vr = runs.runs.filter((r) => r.variant.id === v.id).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            const evals = [...new Set([...v.evaluationIds, ...evaluationIdsOf(vr)])]
            return (
              <section key={v.id} className="stu-sub-group" data-testid="case-variant">
                <h2 className="stu-subtype">
                  {v.label} <span className="tma-muted">· {changeText(v.changeKind)}</span> {v.isBaseline && <Badge tone="neutral">baseline</Badge>}
                </h2>
                <p className="tma-body-sm tma-muted tma-mono">
                  {v.agent.harness}
                  {v.agent.harnessVersion ? ` ${v.agent.harnessVersion}` : ''} · {v.agent.modelId} · agent {sha12(v.agentSha256)} · variant {sha12(v.variantSha256)}
                </p>
                <p className="tma-body-sm">
                  {v.n} runs · {v.pass} pass · {v.fail} fail{v.infraErrors ? ` · ${v.infraErrors} infra errors` : ''}
                  {v.passRate != null ? ` · pass rate ${Math.round(v.passRate * 100)}%` : ''}
                  {v.meanScore != null ? ` · mean score ${v.meanScore}` : ''}
                </p>
                {vr.length > 0 && (
                  <ul className="stu-runs" data-testid="case-variant-runs">
                    {vr.map((r) => {
                      const href = runHref(r)
                      const label = `#${r.seq ?? '?'} ${r.status}${r.score != null ? ` ${r.score}` : ''}`
                      return (
                        <li key={r.id}>
                          {href ? (
                            <Link to={href} data-testid="case-run-link">
                              <Badge tone={statusTone(r.status)}>{label}</Badge>
                            </Link>
                          ) : (
                            <Badge tone={statusTone(r.status)}>{label}</Badge>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {evals.length > 0 && (
                  <p className="tma-body-sm">
                    Evaluations:{' '}
                    {evals.map((e, i) => (
                      <span key={e}>
                        {i > 0 && ', '}
                        <Link to={evaluationHref(e)} className="tma-mono" data-testid="case-evaluation-link">
                          {e.slice(0, 8)}
                        </Link>
                      </span>
                    ))}
                  </p>
                )}
              </section>
            )
          })
        )}
        {runs.truncated && <p className="stu-pad tma-body-sm tma-muted">Showing the newest {runs.limit} runs.</p>}
      </Card>

      <Card pad>
        <CaseCommand detail={detail} runs={runs.runs} />
        <p className="tma-body-sm tma-muted">
          Results show here after <span className="tma-mono">tma eval upload</span>.{' '}
          <Link to={studioHref('S5', { case: detail.id, agent: agentId })} data-testid="case-experiment-link">
            Experiment builder for this case
          </Link>
        </p>
      </Card>
    </>
  )
}
