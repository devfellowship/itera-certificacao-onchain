import { useState } from 'react'
import { ApiError, createEvaluation, type RunResponse } from './api'

/**
 * Doc "1 · Preparar avaliação" (03_produto_mvp_72h.pdf section 2). Vendor/studio operator side —
 * requires the shared operator key (see README "apps/api" section for why this isn't full auth).
 * Only webhook-ledger/1 is a known task pack on the API right now, so the task fields are fixed,
 * not a free picker, until a second pack exists.
 */
export function PreparePage() {
  const [operatorKey, setOperatorKey] = useState('')
  const [vendorName, setVendorName] = useState('')
  const [agentName, setAgentName] = useState('')
  const [endpointUrl, setEndpointUrl] = useState('')
  const [releaseRef, setReleaseRef] = useState('')
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<RunResponse | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const result = await createEvaluation(
        {
          idempotencyKey,
          vendor: { displayName: vendorName },
          agent: { name: agentName, endpointUrl },
          release: { releaseRef },
          task: { id: 'webhook-ledger', version: '1' },
        },
        operatorKey,
      )
      setRun(result)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the API.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="verify-page">
      <h1>Prepare an evaluation</h1>
      <p className="intro">
        Keep your agent's implementation private. Declare the release and the HTTPS endpoint we'll dispatch the task
        to — your buyer never sees the repo, prompts, or internal tools.
      </p>

      <form onSubmit={submit} className="prepare-form">
        <label className="field">
          <span>Operator key</span>
          <input type="password" value={operatorKey} onChange={(e) => setOperatorKey(e.target.value)} required />
        </label>
        <label className="field">
          <span>Vendor / studio name</span>
          <input value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="Demo Studio" required />
        </label>
        <label className="field">
          <span>Agent name</span>
          <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Coding Agent" required />
        </label>
        <label className="field">
          <span>Controlled endpoint (HTTPS, allowlisted)</span>
          <input
            type="url"
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            placeholder="https://agent.example.com/evaluate"
            required
          />
        </label>
        <label className="field">
          <span>Declared release</span>
          <input value={releaseRef} onChange={(e) => setReleaseRef(e.target.value)} placeholder="demo-release-01" required />
        </label>
        <label className="field">
          <span>Task</span>
          <input readOnly value="webhook-ledger · v1" />
        </label>
        <button type="submit" className="primary" disabled={loading}>
          {loading ? 'Preparing…' : 'Prepare test'}
        </button>
      </form>

      {error && <p className="run-result-error">{error}</p>}

      {run && (
        <div className="prepare-result">
          <h3>Run created</h3>
          <p>
            Status: <code>{run.status}</code> · Run ID: <code>{run.runId}</code>
          </p>
          <p className="small">
            Dispatching the challenge to the endpoint and running the grader isn't wired into this API yet — the run
            stays <code>pending</code> until that step exists. Use the run ID on the Observe page.
          </p>
          <a className="secondary" href={`/observe/${run.runId}`}>
            Go to Observe & publish →
          </a>
        </div>
      )}
    </main>
  )
}
