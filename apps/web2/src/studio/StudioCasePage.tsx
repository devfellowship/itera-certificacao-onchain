/**
 * S4 Test case (plan 20261112-tma-c5-studio-area-web2, task C5-T3; redesign UI-S4S6S7), route /studio/cases/:caseId. READ ONLY (ADR-5):
 * no Save, no Run; the copy command is the only action.
 * Data: GET /eval-cases/:id (the case, its graders, its variants with counts) and GET /eval-runs?case=<id> (the
 * uploaded runs). Each run links to its canonical page /evaluations/:eid/runs/:runId, each evaluation to
 * /evaluations/:eid, the task to /tasks/:slug.
 * The task summary shows Before and Expected only (Q-T16 = A); S4 never shows an outcome.
 * Environment: the case's environment is covered by its manifest digest; the API does not store the environment
 * itself (only digests, plan C4 ADR-3), so S4 shows the digest and points to the task page instead of
 * EnvironmentCard.
 *
 * Layout: the canvas artboard "S4 Test case: prompt, environment, graders": a trail bar, the title row, then three numbered
 * steps (1 the real trace, 2 the problem, 3 expected output and graders) and the results of the case. The artboard shows
 * fields the API does not return (trace title and size, repository and commit, grader weight): the page says so in one
 * line each, with no made-up value. Save and Start are not here (ADR-5); the experiment builder is a link.
 */
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { EvalCaseDetail, EvalRun, EvalRunsResponse } from '../lib/api/types'
import type { ReactNode } from 'react'
import { Badge } from '../tma/ui'
import { Crumb, CrumbSep, InfoTip, Step, StudioBar, TitleRow } from './chrome'
import { CopyCommand } from './CopyCommand'
import { caseCommands } from './eval-command'
import { studioHref } from './links'
import { changeText, evaluationHref, evaluationIdsOf, runHref, sha12 } from './runs'
import { Dot, Section, themeClass } from './theme'
import { splitUseCaseKey } from './use-case'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'
import './case-page.css'

type Data = { detail: EvalCaseDetail; runs: EvalRunsResponse }

const CASE_TIP =
  'A test case is the problem, not the solver: the request, the environment it lives in, and the graders that say it was solved. It does not depend on any agent. Agents change separately, as agent variants. The case keeps pointers and hashes only; private text stays on your host.'

export function StudioCasePage() {
  const { caseId = '' } = useParams()
  const loaded = useStudioLoad<Data>(
    () => Promise.all([api.evalCase(caseId), api.evalRuns({ case: caseId })]).then(([detail, runs]) => ({ detail, runs })),
    [caseId],
  )
  const caseKey = loaded.state === 'ok' ? loaded.data.detail.caseKey : 'test case'
  return (
    <main className={themeClass('tma-page', 'stu-page', 'cs-page')} data-testid="studio-case-page">
      <StudioBar
        trail={
          <>
            <Link to="/studio" data-testid="studio-back">
              Studio
            </Link>
            <CrumbSep />
            <Link to="/studio/cases">test cases</Link>
            <CrumbSep />
            <Crumb current>{caseKey}</Crumb>
          </>
        }
      />
      {loaded.state === 'loading' && (
        <div className="stu-body">
          <div className="stu-state" data-testid="studio-loading">
            <span className="tma-body-sm tma-muted">Loading the test case…</span>
          </div>
        </div>
      )}
      {loaded.state === 'error' && (
        <div className="stu-body">
          <div className="stu-state" data-testid="studio-empty">
            <span className="tma-label">{loaded.status === 404 ? 'Test case not found' : 'No test case to show'}</span>
            <p className="tma-body-sm tma-muted" data-testid="studio-load-error">
              {loadErrorText(loaded.status)}
            </p>
            <CaseCommand detail={null} runs={[]} />
          </div>
        </div>
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

const runTone = (status: string): 'ok' | 'bad' | 'warn' | undefined =>
  status === 'pass' ? 'ok' : status === 'fail' ? 'bad' : status === 'infra_error' || status === 'timeout' || status === 'invalid' ? 'warn' : undefined

function CaseView({ detail, runs }: { detail: EvalCaseDetail; runs: EvalRunsResponse }) {
  const { type, subtype } = splitUseCaseKey(detail.useCaseKey)
  const agentId = runs.runs.find((r) => r.agentId)?.agentId ?? null
  const replay = detail.mode !== 'trace_review'
  const modeText = detail.mode === 'trace_review' ? 'trace review' : 'replay'
  const contextRows: Array<{ key: string; testId?: string; value: ReactNode }> = [
    { key: 'Use case', value: <span className="tma-mono">{detail.useCaseKey}</span> },
    { key: 'Mode', value: modeText },
    {
      key: 'Task',
      testId: 'case-task',
      value: detail.taskSlug ? (
        <Link to={`/tasks/${encodeURIComponent(detail.taskSlug)}`} className="stu-link" data-testid="case-task-link">
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
        <span>
          In the case manifest <span className="stu-label">{sha12(detail.manifestSha256)}</span>
          {detail.taskSlug ? ' (the task page shows the task environment).' : '.'}
        </span>
      ),
    },
    { key: 'Origin pin', value: <span className="stu-label">{sha12(detail.originPinSha256)}</span> },
  ]

  return (
    <div className="stu-body">
      <div>
        <TitleRow
          tip={<InfoTip label="About test cases" text={CASE_TIP} />}
          actions={
            <Link to={studioHref('S5', { case: detail.id, agent: agentId })} className="stu-btn stu-btn--primary" data-testid="case-experiment-link">
              Open the experiment builder
            </Link>
          }
        >
          <h1 className="tma-h1" data-testid="case-key">
            {detail.caseKey}
          </h1>
        </TitleRow>
        <div className="stu-tags cs-tags" data-testid="case-use-case">
          <span className="stu-chip stu-chip--sm stu-chip--static">{type}</span>
          {subtype && <span className="stu-chip stu-chip--sm stu-chip--static">{subtype}</span>}
          <span className="stu-chip stu-chip--sm stu-chip--static" data-testid="case-mode">
            {modeText}
          </span>
        </div>
      </div>

      <Step n={1} title="Start from a real trace">
        <div className="cs-trace" data-testid="case-trace">
          <span aria-hidden="true" className="cs-trace__mark">
            TR
          </span>
          <span className="cs-trace__text">
            <span>{detail.originPinSha256 ? 'Pinned recording' : 'No recording pinned'}</span>
            <span className="stu-label">
              {detail.originPinSha256 ? `pin ${sha12(detail.originPinSha256)} · ` : ''}
              {modeText}
            </span>
          </span>
          {detail.taskSlug && (
            <Link to={`/tasks/${encodeURIComponent(detail.taskSlug)}`} className="stu-link cs-trace__link">
              Task page
            </Link>
          )}
        </div>
        <div role="radiogroup" aria-label="How the trace is used" className="cs-modes" data-testid="case-modes">
          <label className={`cs-mode${replay ? ' cs-mode--on' : ''}`}>
            <input type="radio" name="mode" checked={replay} disabled readOnly />
            <span>
              <b>Replay it</b>
              <span className="cs-mode__sub">Agents get the same request and context, and their new results are graded.</span>
            </span>
          </label>
          <label className={`cs-mode${!replay ? ' cs-mode--on' : ''}`}>
            <input type="radio" name="mode" checked={!replay} disabled readOnly />
            <span>
              <b>Only grade the recording</b>
              <span className="cs-mode__sub">No new run. Score what already happened.</span>
            </span>
          </label>
        </div>
        <p className="stu-gap" data-testid="case-gap-trace">
          The case stores a pin and a digest. The trace title, the agent that recorded it, its size and its merge result are not on the case.
        </p>
      </Step>

      <div className="cs-pair" data-task-summary>
        <Step n={2} title="The problem">
          <div className="cs-field">
            <span className="stu-label">
              <b data-summary-label>Before</b> · what the task starts from
            </span>
            <div className="cs-quote" data-testid="summary-before">
              {detail.taskSummary?.before ?? '—'}
            </div>
          </div>
          <div role="table" aria-label="Context" className="cs-table">
            <div role="row" className="cs-table__head">
              <span role="columnheader" className="cs-th">
                Environment
                <InfoTip label="More info" text="Belongs to the case: what exists in the user's world (repo, DB, APIs, CI). The agent's own tools, MCP servers and permissions belong to the agent." />
              </span>
              <span role="columnheader">pinned to</span>
            </div>
            {contextRows.map((r) => (
              <div role="row" key={r.key} className="cs-table__row" data-testid={r.testId}>
                <span role="cell" className="cs-table__k">
                  {r.key}
                </span>
                <span role="cell" className="cs-table__v">
                  {r.value}
                </span>
              </div>
            ))}
          </div>
          <p className="stu-gap" data-testid="case-gap-context">
            The repository and commit, the sandbox, the database and the APIs sit behind the manifest digest. The API returns the digest only.
          </p>
        </Step>

        <Step n={3} title="Expected output and graders">
          <div className="cs-field">
            <span className="stu-label">
              <b data-summary-label>Expected</b> · what counts as solved
            </span>
            <div className="cs-quote cs-quote--plain" data-testid="summary-expected">
              {detail.taskSummary?.expected ?? '—'}
            </div>
          </div>
          <div className="cs-graders" data-testid="case-graders">
            {detail.graders.length ? (
              detail.graders.map((g) => (
                <div key={`${g.id}@${g.semver}`} className="cs-grader">
                  <span className="cs-grader__top">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="stu-ok">
                      <circle cx="12" cy="12" r="9" />
                      <path d="m8 12 3 3 5-6" />
                    </svg>
                    {g.id}
                    <span className="cs-grader__kind">{g.kind}</span>
                  </span>
                  <span className="stu-label" data-testid="case-grader" title={g.kind}>
                    {g.id}@{g.semver}
                  </span>
                </div>
              ))
            ) : (
              <p className="stu-gap">no grading uploaded yet</p>
            )}
          </div>
          {detail.graders.length > 0 && <p className="stu-gap">The weight of a grader is not returned by the API.</p>}
        </Step>
      </div>

      <Section title="Results on this case" meta={`${detail.variants.length} ${detail.variants.length === 1 ? 'variant' : 'variants'}`} data-testid="case-variants">
        {detail.variants.length === 0 ? (
          <p className="stu-gap" data-testid="case-variants-empty">
            No variant has uploaded results on this case yet.
          </p>
        ) : (
          <div className="cs-variants">
            {detail.variants.map((v) => {
              const vr = runs.runs.filter((r) => r.variant.id === v.id).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
              const evals = [...new Set([...v.evaluationIds, ...evaluationIdsOf(vr)])]
              return (
                <section key={v.id} className="cs-variant" data-testid="case-variant">
                  <h3 className="cs-variant__title">
                    {v.label} <span className="stu-label">· {changeText(v.changeKind)}</span>
                    {v.isBaseline && <Badge tone="neutral">baseline</Badge>}
                  </h3>
                  <p className="stu-label cs-variant__agent">
                    {v.agent.harness}
                    {v.agent.harnessVersion ? ` ${v.agent.harnessVersion}` : ''} · {v.agent.modelId} · agent {sha12(v.agentSha256)} · variant {sha12(v.variantSha256)}
                  </p>
                  <p className="cs-variant__stats">
                    {v.n} runs · <span className="stu-ok">{v.pass} pass</span> · <span className={v.fail ? 'stu-bad' : undefined}>{v.fail} fail</span>
                    {v.infraErrors ? <span className="stu-warn"> · {v.infraErrors} infra errors</span> : ''}
                    {v.passRate != null ? ` · pass rate ${Math.round(v.passRate * 100)}%` : ''}
                    {v.meanScore != null ? ` · mean score ${v.meanScore}` : ''}
                  </p>
                  {vr.length > 0 && (
                    <ul className="cs-runs" data-testid="case-variant-runs">
                      {vr.map((r) => {
                        const href = runHref(r)
                        const label = `#${r.seq ?? '?'} ${r.status}${r.score != null ? ` ${r.score}` : ''}`
                        const chip = (
                          <>
                            <Dot tone={runTone(r.status)} />
                            {label}
                          </>
                        )
                        return (
                          <li key={r.id}>
                            {href ? (
                              <Link to={href} className="stu-chip stu-chip--sm" data-testid="case-run-link">
                                {chip}
                              </Link>
                            ) : (
                              <span className="stu-chip stu-chip--sm stu-chip--static">{chip}</span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  {evals.length > 0 && (
                    <p className="stu-label">
                      Evaluations:{' '}
                      {evals.map((e, i) => (
                        <span key={e}>
                          {i > 0 && ', '}
                          <Link to={evaluationHref(e)} className="stu-link" data-testid="case-evaluation-link">
                            {e.slice(0, 8)}
                          </Link>
                        </span>
                      ))}
                    </p>
                  )}
                </section>
              )
            })}
          </div>
        )}
        {runs.truncated && <p className="stu-gap">Showing the newest {runs.limit} runs.</p>}
      </Section>

      <Section title="Try another agent variant">
        <CaseCommand detail={detail} runs={runs.runs} />
        <p className="stu-gap">
          Results show here after <span className="tma-mono">tma eval upload</span>.
        </p>
      </Section>
    </div>
  )
}
