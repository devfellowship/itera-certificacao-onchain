import { useState } from 'react'
import { createVerifierRpc, runVerification, type VerificationReport } from './verify'

/**
 * Build-order item 6: the public verifier. Takes just an attestation mint address (the NFT) and
 * runs the 7 checks from verify.ts — no server, no Supabase, matching William's clarification
 * that "100% on-chain" meant THIS page, not the sandbox run.
 */
export function VerifyPage() {
  const [mintInput, setMintInput] = useState('')
  const [report, setReport] = useState<VerificationReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tamperedHash, setTamperedHash] = useState<string | null>(null)

  async function verify() {
    setLoading(true)
    setError(null)
    setReport(null)
    setTamperedHash(null)
    try {
      const rpc = createVerifierRpc()
      const result = await runVerification(rpc, mintInput.trim() as never)
      setReport(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // Tamper demo: mutate one field of the already-fetched manifest client-side, recompute its
  // sha256, and compare against the REAL on-chain manifest_sha256 (report.manifestSha256) — this
  // is a genuine comparison, not a staged one. Never touches the actual pinned file or the chain;
  // purely a local "what if a byte changed" illustration, proving the hash binding is real.
  async function tamper() {
    if (!report?.manifest) return
    const mutated = { ...(report.manifest as Record<string, unknown>), score: { total: 9999 } }
    const bytes = new TextEncoder().encode(JSON.stringify(mutated, null, 2))
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    setTamperedHash(hex)
  }

  return (
    <main className="verify-page">
      <h1>Verify an Itera credential</h1>
      <p className="intro">
        Paste the attestation NFT's mint address. Every check below runs against Solana devnet and IPFS directly — this page
        never asks our servers whether a result is valid.
      </p>
      <div className="verify-input-row">
        <input
          type="text"
          placeholder="Attestation mint address"
          value={mintInput}
          onChange={(e) => setMintInput(e.target.value)}
        />
        <button type="button" className="primary" onClick={verify} disabled={loading || !mintInput.trim()}>
          {loading ? 'Checking…' : 'Verify'}
        </button>
      </div>

      {error && <p className="run-result-error">{error}</p>}

      {report && (
        <>
          <div className={`verify-banner ${report.overall === 'VERIFIED' ? 'verify-banner-ok' : 'verify-banner-fail'}`}>
            {report.overall}
          </div>
          <ul className="verify-checks">
            {report.checks.map((check) => (
              <li key={check.id} className={`verify-check verify-check-${check.status}`}>
                <span className="verify-check-icon">{check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '—'}</span>
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>

          {report.manifest != null && (
            <div className="tamper-demo">
              <button type="button" className="secondary" onClick={tamper}>
                Tamper demo: mutate the score and re-hash
              </button>
              {tamperedHash && (
                <p className={`run-result ${tamperedHash === report.manifestSha256 ? '' : 'run-result-error'}`}>
                  Changed <code>score.total</code> locally and recomputed sha256: <code>{tamperedHash.slice(0, 16)}…</code> vs the
                  real on-chain <code>manifest_sha256</code>: <code>{(report.manifestSha256 ?? '').slice(0, 16)}…</code> —{' '}
                  {tamperedHash === report.manifestSha256 ? 'unexpectedly matches (bug)' : 'MISMATCH, as expected'}.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </main>
  )
}
