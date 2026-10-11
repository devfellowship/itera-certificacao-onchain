import { useState } from 'react'
import {
  ApiError,
  dispatchEvaluation,
  getRunEvents,
  publishEvaluation,
  type CriterionResult,
  type ObservedEvent,
  type RunEventsResponse,
} from './api'

interface EvidenceManifest {
  score: { total: number }
  patch_scope: { allowed: boolean }
  tests: {
    public_after_patch: { total: number; passed: number; failed: number }
    hidden: { total: number; passed: number; failed: number }
  }
  errors: string[]
}

function isEvidenceManifest(value: unknown): value is EvidenceManifest {
  return typeof value === 'object' && value !== null && 'score' in value && 'tests' in value
}

/**
 * Doc "2 · Execução e publicação" (section 2) — the fornecedor engineer dispatches the challenge,
 * reviews observed events and the real grading result, and publishes the redacted result.
 * Requires the operator key, same as PreparePage.
 */
export function ObservePage({ runId }: { runId: string }) {
  const [operatorKey, setOperatorKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<RunEventsResponse | null>(null)
  const [criteriaResults, setCriteriaResults] = useState<CriterionResult[]>([{ requirement: '', result: 'PASS' }])
  const [limitations, setLimitations] = useState('')
  const [publishResult, setPublishResult] = useState<{ claimManifestId: string } | null>(null)

  async function loadEvents() {
    setLoading(true)
    setError(null)
    try {
      const result = await getRunEvents(runId, operatorKey)
      setRun(result)
      prefillCriteriaFromManifest(result.evidenceManifest)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the API.')
    } finally {
      setLoading(false)
    }
  }

  function prefillCriteriaFromManifest(evidenceManifest: unknown) {
    if (!isEvidenceManifest(evidenceManifest)) return
    const { tests } = evidenceManifest
    setCriteriaResults([
      {
        requirement: 'Public checks pass after the patch',
        result: tests.public_after_patch.failed === 0 && tests.public_after_patch.total > 0 ? 'PASS' : 'FAIL',
      },
      { requirement: 'Hidden checks pass', result: tests.hidden.failed === 0 && tests.hidden.total > 0 ? 'PASS' : 'FAIL' },
    ])
  }

  // Doc section 4, steps 3-6: sends the challenge, waits for the vendor's response, and runs the
  // real grader server-side — can take up to ~90s. Re-loads events afterward so the page shows
  // the real result instead of leaving the operator staring at a stale "pending".
  async function dispatch() {
    setDispatching(true)
    setError(null)
    try {
      await dispatchEvaluation(runId, operatorKey)
      await loadEvents()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the API.')
    } finally {
      setDispatching(false)
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

  const manifest = run && isEvidenceManifest(run.evidenceManifest) ? run.evidenceManifest : null

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
            {run.scoreTotal != null && <> · Score: <code>{run.scoreTotal}/100</code></>}
          </p>
          <ObservedEventsList events={run.events} />

          {run.status === 'pending' && (
            <div className="actions">
              <button type="button" className="primary" onClick={dispatch} disabled={dispatching || !operatorKey}>
                {dispatching ? 'Dispatching & grading (up to ~90s)…' : 'Dispatch & grade'}
              </button>
            </div>
          )}

          {manifest && (manifest.errors.length > 0 || !manifest.patch_scope.allowed) && (
            <div className="callout">
              {!manifest.patch_scope.allowed && 'Scope violation — the patch touched a forbidden path. '}
              {manifest.errors.join(' ')}
            </div>
          )}

          {run.status === 'pending' ? null : (
            <div className="publish-form">
              <h3>Publish the result</h3>
              <p className="small">Pre-filled from the real grading result above — edit before publishing if needed.</p>
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
