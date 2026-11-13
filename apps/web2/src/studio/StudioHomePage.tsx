/**
 * S1 Studio home (plan 20261112-tma-c5-studio-area-web2, task C5-T1; canvas artboard "ToBeHome").
 * Use cases above folders: test cases grouped by the L1 pair type/subtype (parent Q-T17 = A).
 * Studio v1 is READ ONLY (Q-T18 = A): no Save and no Run button here. A test run starts from the
 * copy command of S4 and S5 (Q-T19 = A).
 * Data (C5-T3): the caller's cases from GET /eval-cases (capped by the API; the page says so when the list is
 * truncated). The `cases` prop is a test seam: when given, the page does not call the API.
 * The same page serves /studio/cases (the S4 list); there `?task=<slug>` keeps the cases of one task.
 * Each case links to its S4 page /studio/cases/:caseId.
 */
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { Card, CardHeader } from '../tma/ui'
import { groupByUseCase, isL1Pair, type StudioCase } from './use-case'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

export function StudioHomePage({ cases }: { cases?: StudioCase[] }) {
  const [params] = useSearchParams()
  const task = params.get('task')
  const loaded = useStudioLoad(
    cases ? null : () => api.evalCases().then((r) => ({ cases: r.cases as StudioCase[], truncated: r.truncated, limit: r.limit })),
    [cases ? 'prop' : 'api'],
  )
  const all = cases ?? (loaded.state === 'ok' ? loaded.data.cases : [])
  const list = task ? all.filter((c) => c.taskSlug === task) : all
  const groups = groupByUseCase(list.filter((c) => isL1Pair(c.useCaseKey)))
  // A name that is not one of the 33 pairs never gets its own use case group (Q-T17 = A).
  const unclassified = list.filter((c) => !isL1Pair(c.useCaseKey)).sort((x, y) => x.caseKey.localeCompare(y.caseKey))
  const loading = !cases && loaded.state === 'loading'
  const error = !cases && loaded.state === 'error' ? loaded : null
  return (
    <main className="tma-page" data-testid="studio-home">
      <div className="stu-head">
        <h1 className="tma-h1">Studio</h1>
        <p className="stu-sub">Test cases from real agent work, grouped by use case. Read only.</p>
        <p className="tma-body-sm">
          <Link to="/studio/graders" data-testid="studio-graders-link">
            Graders
          </Link>
        </p>
        {task && (
          <p className="tma-body-sm" data-testid="studio-task-filter">
            Test cases of the task <Link to={`/tasks/${encodeURIComponent(task)}`}>{task}</Link>. <Link to="/studio/cases">Show every case</Link>
          </p>
        )}
      </div>

      {loading ? (
        <Card pad data-testid="studio-loading">
          <span className="tma-body-sm tma-muted">Loading test cases…</span>
        </Card>
      ) : groups.length === 0 && unclassified.length === 0 ? (
        <Card pad data-testid="studio-empty">
          <span className="tma-label">No test cases yet</span>
          {error && (
            <p className="tma-body-sm tma-muted" data-testid="studio-load-error">
              {loadErrorText(error.status)}
            </p>
          )}
          <p className="tma-body-sm tma-muted">
            A test case appears here when it is uploaded with the <span className="tma-mono">tma</span> command. Code tasks are on the{' '}
            <Link to="/tasks" data-testid="studio-tasks-link">
              Tasks
            </Link>{' '}
            page.
          </p>
        </Card>
      ) : (
        <div className="stu-groups">
          {groups.map((g) => (
            <Card key={g.type} data-testid={`use-case-${g.type}`}>
              <CardHeader title={g.type} meta={`${g.total} ${g.total === 1 ? 'case' : 'cases'}`} />
              {g.subtypes.map((s) => (
                <section key={s.subtype ?? ''} className="stu-sub-group" data-testid={`use-case-${g.type}${s.subtype ? `/${s.subtype}` : ''}`}>
                  <h2 className="stu-subtype">{s.subtype ?? 'general'}</h2>
                  <ul className="stu-cases">
                    {s.cases.map((c) => (
                      <li key={c.id ?? c.caseKey} className="tma-mono" data-testid="studio-case">
                        {c.id ? (
                          <Link to={`/studio/cases/${encodeURIComponent(c.id)}`} data-testid="studio-case-link">
                            {c.caseKey}
                          </Link>
                        ) : (
                          c.caseKey
                        )}
                        {c.runCount != null && <span className="tma-muted stu-count"> · {c.runCount} {c.runCount === 1 ? 'run' : 'runs'}</span>}
                        {c.cluster ? (
                          <span className="tma-label" data-testid="l2-tag">
                            {' '}
                            {c.cluster}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </Card>
          ))}
          {unclassified.length > 0 ? (
            <Card data-testid="use-case-unclassified">
              <CardHeader title="Not a taxonomy pair" meta={`${unclassified.length} ${unclassified.length === 1 ? 'case' : 'cases'}`} />
              <ul className="stu-cases">
                {unclassified.map((c) => (
                  <li key={c.caseKey} className="tma-mono" data-testid="studio-case">
                    {c.caseKey} <span className="tma-muted">({c.useCaseKey})</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {!cases && loaded.state === 'ok' && loaded.data.truncated && (
            <p className="tma-body-sm tma-muted" data-testid="studio-truncated">
              Showing the newest {loaded.data.limit} test cases.
            </p>
          )}
          <p className="tma-body-sm tma-muted">
            Code tasks are on the{' '}
            <Link to="/tasks" data-testid="studio-tasks-link">
              Tasks
            </Link>{' '}
            page.
          </p>
        </div>
      )}
    </main>
  )
}
