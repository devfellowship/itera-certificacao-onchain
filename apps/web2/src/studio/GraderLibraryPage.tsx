/**
 * S10 Grader library (plan 20261112-tma-c5-studio-area-web2, task C5-T5). Read only: a table of grader versions
 * (graderId@semver, kind, short digest, used-by count); a row opens S10a. Data: GET /grader-versions.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../tma/ui'
import { failedState, listGraderVersions, shortDigest, type GraderVersionItem, type Loaded } from './graders'
import './studio.css'

export function GraderLibraryView({ items }: { items: GraderVersionItem[] }) {
  if (items.length === 0) return <GraderEmpty text="A grader version appears here when a result that it graded is uploaded with the tma command." />
  return (
    <Card data-testid="grader-table">
      <table className="stu-table">
        <thead>
          <tr>
            <th>Grader</th>
            <th>Kind</th>
            <th>Digest</th>
            <th>Used by</th>
          </tr>
        </thead>
        <tbody>
          {items.map((g) => (
            <tr key={g.id} data-testid={`grader-row-${g.graderId}`}>
              <td>
                <Link to={`/studio/graders/${g.id}`} className="tma-mono" data-testid="grader-link">
                  {g.graderId}@{g.semver}
                </Link>
              </td>
              <td>{g.kind}</td>
              <td className="tma-mono" title={g.codeSha256} data-testid="grader-digest">
                {shortDigest(g.codeSha256)}
              </td>
              <td data-testid="grader-used-by">{g.usedByCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

export function GraderEmpty({ text }: { text: string }) {
  return (
    <Card pad data-testid="graders-empty">
      <span className="tma-label">No grader versions yet</span>
      <p className="tma-body-sm tma-muted">{text}</p>
    </Card>
  )
}

export function GraderLibraryPage() {
  const [s, setS] = useState<Loaded<GraderVersionItem[]>>({ state: 'loading' })
  useEffect(() => {
    let live = true
    listGraderVersions().then(
      (r) => live && setS({ state: 'ready', data: r.graderVersions }),
      (e) => live && setS(failedState(e)),
    )
    return () => {
      live = false
    }
  }, [])
  return (
    <main className="tma-page" data-testid="studio-graders">
      <div className="stu-head">
        <h1 className="tma-h1">Graders</h1>
        <p className="stu-sub">Grader versions that graded your results. Read only.</p>
      </div>
      {s.state === 'loading' && <p className="tma-body-sm tma-muted">Loading graders…</p>}
      {s.state === 'ready' && <GraderLibraryView items={s.data} />}
      {(s.state === 'unavailable' || s.state === 'not-found') && <GraderEmpty text="The grader library is not available yet on this server." />}
      {s.state === 'error' && <p role="alert">{s.message}</p>}
    </main>
  )
}
