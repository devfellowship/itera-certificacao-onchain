/**
 * S1 Studio home (plan 20261112-tma-c5-studio-area-web2, task C5-T1; canvas artboard "ToBeHome").
 * Use cases above folders: test cases grouped by the L1 pair type/subtype (parent Q-T17 = A).
 * Studio v1 is READ ONLY (Q-T18 = A): no Save and no Run button here. A test run starts from the
 * copy command of a later screen (Q-T19 = A).
 * Data: the cases come from the `cases` prop. The TMA API has no list route for cases yet (C5-T3 adds
 * the read path on the C4 API), so the default is an empty list and the page shows its empty state.
 */
import { Link } from 'react-router-dom'
import { Card, CardHeader } from '../tma/ui'
import { groupByUseCase, type StudioCase } from './use-case'
import './studio.css'

export function StudioHomePage({ cases = [] }: { cases?: StudioCase[] }) {
  const groups = groupByUseCase(cases)
  return (
    <main className="tma-page" data-testid="studio-home">
      <div className="stu-head">
        <h1 className="tma-h1">Studio</h1>
        <p className="stu-sub">Test cases from real agent work, grouped by use case. Read only.</p>
      </div>

      {groups.length === 0 ? (
        <Card pad data-testid="studio-empty">
          <span className="tma-label">No test cases yet</span>
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
                      <li key={c.caseKey} className="tma-mono" data-testid="studio-case">
                        {c.caseKey}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </Card>
          ))}
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
