import { useState } from 'react'
import {
  ApiError,
  getRunEvents,
  publishEvaluation,
  type CriterionResult,
  type ObservedEvent,
  type RunEventsResponse,
} from './api'

/**
 * Doc "2 · Execução e publicação" (section 2) — the fornecedor engineer reviews observed events
 * and publishes the redacted result. Requires the operator key, same as PreparePage.
 */
export function ObservePage({ runId }: { runId: string }) {
  const [operatorKey, setOperatorKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<RunEventsResponse | null>(null)
  const [criteriaResults, setCriteriaResults] = useState<CriterionResult[]>([{ requirement: '', result: 'PASS' }])
  const [limitations, setLimitations] = useState('')
  const [publishResult, setPublishResult] = useState<{ claimManifestId: string } | null>(null)

  async function loadEvents() {
    setLoading(true)
    setError(null)
    try {
      setRun(await getRunEvents(runId, operatorKey))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the API.')
    } finally {
      setLoading(false)
    }
  }

  async function publish() {
    setLoading(true)
    setError(null)
    try {
      const result = await publishEvaluation(
        runId,
        { criteriaResults: criteriaResults.filter((c) => c.requirement.trim()), limitations: limitations || undefined },
        operatorKey,
      )
      setPublishResult(result)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the API.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="verify-page">
      <h1>Observe & publish</h1>
      <p className="intro">
        Run <code>{runId}</code>. Only events actually observed — the desafio enviado, artefato recebido, and grading
        trail — not animated internals the endpoint never showed us.
      </p>

      <div className="verify-input-row">
        <input type="password" placeholder="Operator key" value={operatorKey} onChange={(e) => setOperatorKey(e.target.value)} />
        <button type="button" className="primary" onClick={loadEvents} disabled={loading || !operatorKey}>
          {loading ? 'Loading…' : 'Load events'}
        </button>
      </div>

      {error && <p className="run-result-error">{error}</p>}

      {run && (
        <>
          <p>
            Task status: <code>{run.status}</code>
          </p>
          <ObservedEventsList events={run.events} />

          {run.status === 'pending' ? (
            <div className="callout">
              This run hasn't been graded yet. Dispatching the challenge to the vendor's endpoint and running the
              grader isn't wired into this API yet, so publishing will be refused until the run resolves to a real
              task outcome.
            </div>
          ) : (
            <div className="publish-form">
              <h3>Publish the result</h3>
              {criteriaResults.map((c, i) => (
                <div key={i} className="verify-input-row">
                  <input
                    placeholder="Requirement"
                    value={c.requirement}
                    onChange={(e) =>
                      setCriteriaResults((prev) => prev.map((p, j) => (j === i ? { ...p, requirement: e.target.value } : p)))
                    }
                  />
                  <input
                    placeholder="PASS / FAIL"
                    value={c.result}
                    onChange={(e) => setCriteriaResults((prev) => prev.map((p, j) => (j === i ? { ...p, result: e.target.value } : p)))}
                  />
                </div>
              ))}
              <button type="button" className="secondary" onClick={() => setCriteriaResults((prev) => [...prev, { requirement: '', result: 'PASS' }])}>
                + Add requirement
              </button>
              <label className="field">
                <span>Limitations</span>
                <textarea value={limitations} onChange={(e) => setLimitations(e.target.value)} />
              </label>
              <button type="button" className="primary" onClick={publish} disabled={loading}>
                Publish result
              </button>
            </div>
          )}
        </>
      )}

      {publishResult && (
        <div className="prepare-result">
          <h3>Published</h3>
          <a className="secondary" href={`/credentials/${publishResult.claimManifestId}`}>
            View the credential →
          </a>
        </div>
      )}
    </main>
  )
}

function ObservedEventsList({ events }: { events: ObservedEvent[] }) {
  if (events.length === 0) return <p className="small">No events observed yet for this run.</p>
  return (
    <ul className="verify-checks">
      {events.map((e) => (
        <li key={e.id} className="verify-check">
          <div>
            <strong>{e.mode === 'observed' ? 'Observed' : 'Vendor-declared'}</strong>
            <p>
              request: {e.requestDigest ?? '—'} · response: {e.responseDigest ?? '—'} · artifact: {e.outputArtifactRef ?? '—'}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}
