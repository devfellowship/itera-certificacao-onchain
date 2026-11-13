/**
 * "Try this grader (dry run)" (plan 20261112-tma-c5-studio-area-web2, task C5-T10; Tainan Q-C5-2b = A).
 * One grader grades one output on `tma studio serve` (POST <serve>/grade/dry-run) and the panel shows the result.
 * ADR-5 holds: there is no Save anywhere; the panel only does a dry run, and nothing is stored on the server.
 * The panel is hidden when VITE_TMA_STUDIO_SERVE_URL is empty (the default).
 *
 * Reusable on purpose: S10a mounts it on the grader detail; S11a (judge calibration, plan C6) can mount the same
 * component with the judge's `graderId@semver`.
 *
 * The call sends the web2 session bearer (the same token the TMA API client holds). The token is never logged and
 * never shown.
 */
import { useState, type FormEvent } from 'react'
import { loadSession } from '../auth/sessionStorage'
import { STUDIO_SERVE_URL } from '../config'
import { getSessionToken } from '../lib/api'
import { Card, CardHeader } from '../tma/ui'

export interface DryRunResult {
  pass: boolean
  score: number | null
  details: { infra_ok: boolean; reason: string | null; grader: { id: string; version: string; kind: string }; output_sha256: string }
  durationMs: number
  stored: false
}

export type DryRunOutcome =
  | { kind: 'result'; data: DryRunResult }
  | { kind: 'refused'; status: number; error: string; message: string }
  | { kind: 'network'; message: string }

/** The bearer of the web2 session: the API client's token, else the stored session. */
export function sessionBearer(): string | null {
  return getSessionToken() ?? loadSession()?.token ?? null
}

/** POST <serveUrl>/grade/dry-run. Never throws: a refusal and a network error are outcomes. */
export async function postDryRun(
  serveUrl: string,
  token: string | null,
  body: { grader: string; output: string; expected?: string },
): Promise<DryRunOutcome> {
  let res: Response
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    res = await fetch(`${serveUrl.replace(/\/+$/, '')}/grade/dry-run`, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch {
    return { kind: 'network', message: 'The studio service did not answer. Check that tma studio serve is reachable.' }
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (res.ok && json && typeof json.pass === 'boolean') return { kind: 'result', data: json as unknown as DryRunResult }
  const error = typeof json?.error === 'string' ? json.error : `http_${res.status}`
  const message = typeof json?.message === 'string' ? json.message : `The studio service answered ${res.status}.`
  return { kind: 'refused', status: res.status, error, message }
}

export function GraderDryRunPanel({
  grader,
  kind,
  serveUrl = STUDIO_SERVE_URL,
  getToken = sessionBearer,
}: {
  /** `graderId@semver`. */
  grader: string
  kind: 'code' | 'judge' | 'human'
  serveUrl?: string
  getToken?: () => string | null
}) {
  const [output, setOutput] = useState('')
  const [expected, setExpected] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<DryRunOutcome | null>(null)
  if (!serveUrl || kind === 'human') return null

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setOutcome(null)
    const r = await postDryRun(serveUrl, getToken(), { grader, output, ...(expected ? { expected } : {}) })
    setOutcome(r)
    setBusy(false)
  }

  return (
    <Card data-testid="dry-run-panel">
      <CardHeader title="Try this grader (dry run)" meta={grader} />
      <form className="stu-dry tma-card--pad" onSubmit={(e) => void submit(e)}>
        <label className="tma-label" htmlFor="dry-run-output">Output to grade</label>
        <textarea id="dry-run-output" data-testid="dry-run-output" value={output} onChange={(e) => setOutput(e.target.value)} />
        <label className="tma-label" htmlFor="dry-run-expected">{kind === 'judge' ? 'Expected (the judge reads it)' : 'Expected (only if the grader reads it)'}</label>
        <textarea id="dry-run-expected" data-testid="dry-run-expected" value={expected} onChange={(e) => setExpected(e.target.value)} />
        <div>
          <button type="submit" disabled={busy || output === ''} data-testid="dry-run-button">
            Dry run
          </button>
        </div>
        <p className="tma-body-sm tma-muted">Nothing is stored.</p>
        {busy && <p className="tma-body-sm tma-muted">Grading…</p>}
        {outcome && (
          <div className="stu-dry__result" data-testid="dry-run-result" data-outcome={outcome.kind} role={outcome.kind === 'result' ? 'status' : 'alert'}>
            {outcome.kind === 'result' && (
              <dl className="stu-dl">
                <dt>Verdict</dt>
                <dd data-testid="dry-run-verdict">{!outcome.data.details.infra_ok ? 'not measured' : outcome.data.pass ? 'pass' : 'fail'}</dd>
                <dt>Score</dt>
                <dd>{outcome.data.score ?? 'n/a'}</dd>
                {outcome.data.details.reason && (<><dt>Reason</dt><dd>{outcome.data.details.reason}</dd></>)}
                <dt>Time</dt>
                <dd>{outcome.data.durationMs} ms</dd>
              </dl>
            )}
            {outcome.kind === 'refused' && (
              <p>
                <span className="tma-mono">{outcome.error}</span>: {outcome.message}
              </p>
            )}
            {outcome.kind === 'network' && <p>{outcome.message}</p>}
          </div>
        )}
      </form>
    </Card>
  )
}
