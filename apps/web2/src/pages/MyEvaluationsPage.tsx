/** My evaluations (plan 20261015-testmyagent-web2-client, T9). Graded-only: no share, proof or NFT links. */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../auth/session'
import { api, type EvaluationListItem } from '../lib/api'
import { apiErrorMessage } from '../lib/errors'
import { RequireLogin } from './RequireLogin'

export function MyEvaluationsPage() {
  return (
    <RequireLogin what="see your evaluations">
      <MyEvaluationsList />
    </RequireLogin>
  )
}

function MyEvaluationsList() {
  const { apiFetch } = useSession()
  const [rows, setRows] = useState<EvaluationListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void api.myEvaluations(apiFetch).then((res) => {
      if (!alive) return
      if (res.ok) setRows(res.body.evaluations)
      else setError(apiErrorMessage(res.status, res.body))
    })
    return () => {
      alive = false
    }
  }, [apiFetch])

  return (
    <main className="w2-shell w2-wide">
      <h1>My evaluations</h1>
      <p>
        <Link to="/evaluate" className="w2-btn" data-testid="new-evaluation">
          New evaluation
        </Link>
      </p>
      {error ? (
        <p className="w2-error" role="alert" data-testid="evaluation-error">
          {error}
        </p>
      ) : rows === null ? (
        <p className="w2-lead">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="w2-muted" data-testid="evaluations-empty">
          You have no evaluations yet.
        </p>
      ) : (
        <table className="w2-table" data-testid="evaluations-list">
          <thead>
            <tr>
              <th>Evaluation</th>
              <th>Agent</th>
              <th>Tasks</th>
              <th>Status</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} data-testid="evaluation-row">
                <td>
                  <Link to={`/evaluations/${encodeURIComponent(e.id)}`} className="tma-mono">
                    {e.shortId}
                  </Link>
                  <div className="w2-muted">{new Date(e.createdAt).toLocaleString()}</div>
                </td>
                <td>{e.agent.name}</td>
                <td>{e.tasks.map((t) => t.name).join(', ')}</td>
                <td>{e.status}</td>
                <td className="tma-mono">{e.score === null ? '—' : e.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
