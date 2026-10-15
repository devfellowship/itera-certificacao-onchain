/**
 * One evaluation (plan 20261015-testmyagent-web2-client, T9): the running view, then the result.
 * It polls `GET /evaluations/:id` until an end state (graded, failed, cancelled, review).
 * A web2 evaluation ends at `graded`: the page shows the score and no proof, verify or NFT link.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useSession } from '../auth/session'
import { api, TERMINAL_STATUSES, type EvaluationDetail } from '../lib/web2-api'
import { apiErrorMessage } from '../lib/errors'
import { RequireLogin } from './RequireLogin'

export const POLL_MS = 3000

const STATUS_TEXT: Record<string, string> = {
  pending: 'Queued',
  in_progress: 'Running',
  graded: 'Graded',
  failed: 'Failed',
  review: 'Needs review (platform fault)',
  cancelled: 'Cancelled',
  issuing: 'Issuing',
  issued: 'Issued',
}

const RUN_STATUS_TEXT: Record<string, string> = {
  queued: 'Queued',
  pending: 'Queued',
  running: 'Running',
  pass: 'Pass',
  fail: 'Fail',
  invalid: 'Invalid',
  timeout: 'Timed out',
  infra_error: 'Platform fault',
  cancelled: 'Cancelled',
}

export function EvaluationPage({ pollMs = POLL_MS }: { pollMs?: number }) {
  return (
    <RequireLogin what="see this evaluation">
      <EvaluationView pollMs={pollMs} />
    </RequireLogin>
  )
}

function formatScore(score: number | null): string {
  return score === null ? '—' : String(score)
}

function EvaluationView({ pollMs }: { pollMs: number }) {
  const { id = '' } = useParams()
  const { apiFetch } = useSession()
  const [ev, setEv] = useState<EvaluationDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  const load = useCallback(async () => {
    const res = await api.evaluation(apiFetch, id)
    if (!alive.current) return
    if (!res.ok) {
      setError(res.status === 404 ? 'Evaluation not found.' : apiErrorMessage(res.status, res.body))
      // A transient failure keeps polling; a 404 stops.
      if (res.status !== 404) timer.current = setTimeout(() => void load(), pollMs)
      return
    }
    setError(null)
    setEv(res.body)
    if (!TERMINAL_STATUSES.has(res.body.status)) timer.current = setTimeout(() => void load(), pollMs)
  }, [apiFetch, id, pollMs])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load])

  async function cancel() {
    setCancelling(true)
    setActionError(null)
    const res = await api.cancelEvaluation(apiFetch, id)
    setCancelling(false)
    if (!res.ok) {
      setActionError(apiErrorMessage(res.status, res.body))
      return
    }
    if (timer.current) clearTimeout(timer.current)
    await load()
  }

  if (!ev) {
    return (
      <main className="w2-shell">
        <h1>Evaluation</h1>
        {error ? (
          <p className="w2-error" role="alert" data-testid="evaluation-error">
            {error}
          </p>
        ) : (
          <p className="w2-lead">Loading…</p>
        )}
      </main>
    )
  }

  const done = TERMINAL_STATUSES.has(ev.status)
  const cancellable = ev.status === 'pending' || ev.status === 'in_progress'

  return (
    <main className="w2-shell w2-wide">
      <p className="w2-eyebrow tma-mono">Evaluation {ev.shortId}</p>
      <h1>{ev.agent.name}</h1>
      <p className="w2-lead">
        Model <span className="tma-mono">{ev.model.id}</span> · {ev.taskCount} task{ev.taskCount === 1 ? '' : 's'}
      </p>
      <p className={`w2-status w2-status-${ev.status}`} data-testid="evaluation-status" data-status={ev.status} aria-live="polite">
        {STATUS_TEXT[ev.status] ?? ev.status}
      </p>
      {error ? (
        <p className="w2-error" role="alert">
          {error}
        </p>
      ) : null}

      {done ? (
        <section className="w2-result" aria-label="Result">
          <p className="w2-result-label">Score (mean of the graded runs&apos; score_total)</p>
          <p className="w2-result-score tma-mono" data-testid="score-total">
            {formatScore(ev.score)}
          </p>
          <p className="w2-muted">
            {ev.counts.pass} pass · {ev.counts.fail} fail · {ev.counts.invalid} invalid
          </p>
        </section>
      ) : null}

      <section className="w2-section" aria-label="Runs">
        <h2>Runs</h2>
        <table className="w2-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Task</th>
              <th>Status</th>
              <th>Tests</th>
              <th>score_total</th>
            </tr>
          </thead>
          <tbody>
            {ev.tasks.map((t) => (
              <tr key={t.runId} data-testid="run-row" data-status={t.status}>
                <td>{t.seq}</td>
                <td>{t.name}</td>
                <td data-testid="run-status">{RUN_STATUS_TEXT[t.status] ?? t.status}</td>
                <td>{t.testsTotal !== null ? `${t.testsPassed ?? 0}/${t.testsTotal}` : '—'}</td>
                <td className="tma-mono" data-testid="run-score">
                  {formatScore(t.score)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {cancellable ? (
        <button type="button" className="w2-btn w2-btn-ghost" data-testid="cancel-evaluation" disabled={cancelling} onClick={() => void cancel()}>
          {cancelling ? 'Cancelling…' : 'Cancel evaluation'}
        </button>
      ) : null}
      {actionError ? (
        <p className="w2-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <p>
        <Link to="/evaluations">My evaluations</Link> · <Link to="/evaluate">New evaluation</Link>
      </p>
    </main>
  )
}
