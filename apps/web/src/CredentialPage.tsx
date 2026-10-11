import { useEffect, useState } from 'react'
import {
  ApiError,
  exportCredentialUrl,
  getCredential,
  submitEvaluationRequest,
  verifyCredential,
  type CredentialResponse,
  type VerifyResponse,
} from './api'

/**
 * Doc "3 · Credencial para o cliente" + "4 · Verificador e consumo" (section 2), combined into one
 * buyer-facing page. Public, read-only — no operator key. The doc treats these as two surfaces for
 * two slightly different audiences (buyer vs. technical integrator), but both are "read this claim
 * and optionally verify it" actions on the same record, so one page with an inline verify action
 * avoids a redundant page hop without losing either capability.
 */
export function CredentialPage({ claimManifestId }: { claimManifestId: string }) {
  const [credential, setCredential] = useState<CredentialResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)

  useEffect(() => {
    getCredential(claimManifestId)
      .then(setCredential)
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : 'Could not reach the API.'))
  }, [claimManifestId])

  async function runVerify() {
    setVerifying(true)
    try {
      setVerifyResult(await verifyCredential(claimManifestId))
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not reach the API.')
    } finally {
      setVerifying(false)
    }
  }

  if (loadError && !credential) {
    return (
      <main className="verify-page">
        <h1>Credential</h1>
        <p className="run-result-error">{loadError}</p>
      </main>
    )
  }

  if (!credential) {
    return (
      <main className="verify-page">
        <h1>Credential</h1>
        <p className="intro">Loading…</p>
      </main>
    )
  }

  return (
    <main className="verify-page">
      <h1>{credential.task}</h1>
      <p className="intro">
        Release <code>{credential.release}</code> · this claim covers the task above, under the conditions evaluated.
        It doesn't mean general competence or a guarantee of future behavior.
      </p>

      <ul className="verify-checks">
        {credential.criteriaResults.map((c, i) => (
          <li key={i} className={`verify-check verify-check-${c.result.toLowerCase() === 'pass' ? 'pass' : 'fail'}`}>
            <span className="verify-check-icon">{c.result.toLowerCase() === 'pass' ? '✓' : '✗'}</span>
            <div>
              <strong>{c.requirement}</strong>
              <p>{c.result}</p>
            </div>
          </li>
        ))}
      </ul>

      {credential.limitations && (
        <div className="callout">
          <strong>Limitations:</strong> {credential.limitations}
        </div>
      )}

      <div className="actions">
        <button type="button" className="primary" onClick={runVerify} disabled={verifying}>
          {verifying ? 'Verifying…' : 'Verify registry'}
        </button>
        <a className="secondary" href={exportCredentialUrl(claimManifestId)}>
          Get credential package ↓
        </a>
        <button type="button" className="ghost" onClick={() => setRequestOpen((v) => !v)}>
          Request a test on my task
        </button>
      </div>

      {verifyResult && (
        <ul className="verify-checks">
          {verifyResult.checks.map((c) => (
            <li key={c.id} className={`verify-check verify-check-${c.status}`}>
              <span className="verify-check-icon">{c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '—'}</span>
              <div>
                <strong>{c.id}</strong>
                <p>{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {requestOpen && <EvaluationRequestForm onClose={() => setRequestOpen(false)} />}
    </main>
  )
}

function EvaluationRequestForm({ onClose }: { onClose: () => void }) {
  const [contact, setContact] = useState('')
  const [description, setDescription] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    try {
      await submitEvaluationRequest({ requesterContact: contact, taskDescription: description })
      setSubmitted(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the API.')
    }
  }

  if (submitted) return <p className="small">Request received. No code, keys, or confidential data — thank you.</p>

  return (
    <form onSubmit={submit} className="prepare-form">
      <label className="field">
        <span>Contact</span>
        <input value={contact} onChange={(e) => setContact(e.target.value)} required />
      </label>
      <label className="field">
        <span>What should the agent demonstrate?</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} required />
      </label>
      {error && <p className="run-result-error">{error}</p>}
      <div className="actions">
        <button type="submit" className="primary">
          Send request
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}
