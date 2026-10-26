import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSession } from '../auth/session'
import { api, type CliLoginRequest } from '../lib/web2-api'
import type { ApiErrorBody } from '../lib/errors'
import { Button, Card, Field, Input } from '../tma/ui'

/**
 * /cli — the approve page of `tma login` (plan 20261026-tma-local-runner-and-self-declared-results,
 * §4 "How login works", ADR-7; task L5). The CLI prints a user code (ABCD-EFGH) and opens
 * `/cli?code=ABCD-EFGH`. The user is signed in with Login with DFL (the route sits behind
 * RequireSession, which comes back to this URL), sees the request, and clicks Allow or Deny.
 *
 * The page never sees the device code or the CLI session token: the CLI takes the token itself
 * with POST /auth/cli/token.
 */

/** `abcd efgh` / `ABCDEFGH` / `abcd-efgh` → `ABCD-EFGH`, else null. Same rule as the API. */
export function normalizeUserCode(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 20) return null
  const compact = raw.toUpperCase().replace(/[\s-]/g, '')
  if (!/^[A-Z0-9]{8}$/.test(compact)) return null
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}

/** The message for a refused CLI login call. */
export function cliErrorMessage(status: number, body: ApiErrorBody | null): string {
  switch (body?.error) {
    case 'code_not_found':
      return 'No login request has this code. Check the code in your terminal, or run tma login again.'
    case 'code_expired':
      return 'This code is expired. Run tma login again in your terminal.'
    case 'code_already_used':
      return 'This code was already approved or denied. Run tma login again for a new code.'
    case 'invalid_user_code':
      return 'A code has 8 letters or digits, as ABCD-EFGH.'
    case 'cli_login_dfl_only':
      return 'The CLI login takes a Login with DFL session. Sign out and sign in with DFL.'
    case 'cli_session_cannot_approve':
      return 'Approve a CLI login on this page, not from a CLI session.'
    case 'rate_limited':
      return 'Too many login requests. Wait a few minutes and try again.'
    case 'schema_not_ready':
      return 'The CLI login is not available yet. Try again later.'
  }
  if (status === 0) return 'We cannot reach TestMyAgent. Check your connection and try again.'
  return 'The request failed. Try again.'
}

type Phase =
  | { kind: 'enter' }
  | { kind: 'loading'; code: string }
  | { kind: 'review'; req: CliLoginRequest }
  | { kind: 'sending'; req: CliLoginRequest }
  | { kind: 'approved'; req: CliLoginRequest }
  | { kind: 'denied'; req: CliLoginRequest }
  | { kind: 'closed'; req: CliLoginRequest }
  | { kind: 'error'; message: string }

const CLOSED_TEXT: Record<string, string> = {
  approved: 'This login is already approved. Go back to your terminal.',
  consumed: 'This login is already done. Your terminal has its session.',
  denied: 'This login was denied. Run tma login again for a new code.',
  revoked: 'This CLI session was revoked. Run tma login again.',
  expired: 'This code is expired. Run tma login again in your terminal.',
}

export function CliLoginPage() {
  const { apiFetch } = useSession()
  const [q, setQ] = useSearchParams()
  const urlCode = normalizeUserCode(q.get('code'))
  const [typed, setTyped] = useState('')
  const [phase, setPhase] = useState<Phase>(urlCode ? { kind: 'loading', code: urlCode } : { kind: 'enter' })

  useEffect(() => {
    if (!urlCode) {
      setPhase({ kind: 'enter' })
      return
    }
    let live = true
    setPhase({ kind: 'loading', code: urlCode })
    api.cliRequest(apiFetch, urlCode).then((r) => {
      if (!live) return
      if (!r.ok) setPhase({ kind: 'error', message: cliErrorMessage(r.status, r.body) })
      else if (r.body.state === 'pending') setPhase({ kind: 'review', req: r.body })
      else setPhase({ kind: 'closed', req: r.body })
    })
    return () => {
      live = false
    }
  }, [urlCode, apiFetch])

  const submitCode = (e: FormEvent) => {
    e.preventDefault()
    const code = normalizeUserCode(typed)
    if (!code) {
      setPhase({ kind: 'error', message: cliErrorMessage(400, { error: 'invalid_user_code' }) })
      return
    }
    setQ({ code }, { replace: true })
  }

  const decide = async (req: CliLoginRequest, action: 'approve' | 'deny') => {
    setPhase({ kind: 'sending', req })
    const r = action === 'approve' ? await api.cliApprove(apiFetch, req.user_code) : await api.cliDeny(apiFetch, req.user_code)
    if (!r.ok) setPhase({ kind: 'error', message: cliErrorMessage(r.status, r.body) })
    else setPhase({ kind: action === 'approve' ? 'approved' : 'denied', req: r.body })
  }

  const req = 'req' in phase ? phase.req : null

  return (
    <main className="tma-page" data-testid="cli-login">
      <Card pad style={{ maxWidth: 520, margin: '48px auto 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span className="tma-h3">Sign in the tma CLI</span>

        {phase.kind === 'enter' && (
          <form onSubmit={submitCode} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span className="tma-body-sm tma-muted">Type the code that tma login shows in your terminal.</span>
            <Field label="Code" htmlFor="cli-code">
              <Input id="cli-code" mono autoComplete="off" placeholder="ABCD-EFGH" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="cli-code-input" />
            </Field>
            <div>
              <Button variant="primary" type="submit" data-testid="cli-code-submit">
                Continue
              </Button>
            </div>
          </form>
        )}

        {phase.kind === 'loading' && <span className="tma-body-sm tma-muted">Reading the login request…</span>}

        {req && (
          <dl className="tma-body-sm" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: 0 }}>
            <dt className="tma-muted">Code</dt>
            <dd style={{ margin: 0 }} data-testid="cli-user-code">
              <code>{req.user_code}</code>
            </dd>
            <dt className="tma-muted">Client</dt>
            <dd style={{ margin: 0 }} data-testid="cli-client-name">
              {req.client_name ?? 'tma CLI'}
            </dd>
          </dl>
        )}

        {(phase.kind === 'review' || phase.kind === 'sending') && (
          <>
            <span className="tma-body-sm">
              Allow this terminal to act as you on TestMyAgent for 24 hours? It can create local agents and upload self-declared results. Allow
              only if you started tma login yourself and the code matches your terminal.
            </span>
            <div className="tma-row" style={{ gap: 12 }}>
              <Button variant="primary" disabled={phase.kind === 'sending'} onClick={() => decide(phase.req, 'approve')} data-testid="cli-allow">
                Allow
              </Button>
              <Button variant="secondary" disabled={phase.kind === 'sending'} onClick={() => decide(phase.req, 'deny')} data-testid="cli-deny">
                Deny
              </Button>
            </div>
          </>
        )}

        {phase.kind === 'approved' && (
          <span className="tma-body-sm" role="status" data-testid="cli-approved">
            Done. Go back to your terminal: tma login finishes by itself.
          </span>
        )}
        {phase.kind === 'denied' && (
          <span className="tma-body-sm" role="status" data-testid="cli-denied">
            Denied. The terminal gets no session.
          </span>
        )}
        {phase.kind === 'closed' && (
          <span className="tma-body-sm" role="status" data-testid="cli-closed">
            {CLOSED_TEXT[phase.req.state] ?? 'This login request is closed.'}
          </span>
        )}
        {phase.kind === 'error' && (
          <span className="tma-field__error" role="alert" data-testid="cli-error">
            {phase.message}
          </span>
        )}
      </Card>
    </main>
  )
}
