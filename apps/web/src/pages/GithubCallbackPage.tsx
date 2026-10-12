import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { GithubCallbackParams, GithubCallbackResponse } from '../lib/api'
import { Button, ButtonLink, Card } from '../tma/ui'
import { describeCallbackError } from './add-agent/errors'

// GitHub's `code` is single-use. React StrictMode runs effects twice in development and a remount
// must not spend the code again, so the call is shared per code.
const inflight = new Map<string, Promise<GithubCallbackResponse>>()
function connectOnce(params: GithubCallbackParams): Promise<GithubCallbackResponse> {
  const key = `${params.installation_id}:${params.code ?? ''}:${params.state ?? ''}`
  let p = inflight.get(key)
  if (!p) {
    p = api.githubCallback(params)
    inflight.set(key, p)
  }
  return p
}

type State = { phase: 'working' } | { phase: 'done'; account: string | null } | { phase: 'error'; message: string } | { phase: 'pending-approval' }

/**
 * /connect/github/callback — GitHub sends the user here after the App install. It forwards
 * installation_id, code and state to GET /github/callback (with the session token when there is
 * one; the signed state also names the wallet), then returns to Add agent.
 */
export function GithubCallbackPage() {
  const [q] = useSearchParams()
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ phase: 'working' })

  useEffect(() => {
    const installationId = q.get('installation_id')
    if (q.get('setup_action') === 'request' && !installationId) {
      setState({ phase: 'pending-approval' })
      return
    }
    if (!installationId) {
      setState({ phase: 'error', message: 'GitHub did not send an installation. Start again from Add agent.' })
      return
    }
    let live = true
    const params: GithubCallbackParams = { installation_id: installationId }
    for (const k of ['code', 'state', 'setup_action'] as const) {
      const v = q.get(k)
      if (v) params[k] = v
    }
    connectOnce(params).then(
      (r) => {
        if (!live) return
        setState({ phase: 'done', account: r.accountLogin })
        navigate('/agents/new?github=connected', { replace: true })
      },
      (e: unknown) => live && setState({ phase: 'error', message: describeCallbackError(e) }),
    )
    return () => {
      live = false
    }
  }, [q, navigate])

  return (
    <main className="tma-page" data-testid="github-callback">
      <Card pad style={{ maxWidth: 480, margin: '48px auto 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {state.phase === 'working' && (
          <>
            <span className="tma-h3">Connecting GitHub…</span>
            <span className="tma-body-sm tma-muted">Checking the installation of the testmyagent app.</span>
          </>
        )}
        {state.phase === 'done' && (
          <>
            <span className="tma-h3">GitHub connected</span>
            <span className="tma-body-sm tma-muted">{state.account ? `App installed on ${state.account}. ` : ''}Taking you back to Add agent.</span>
          </>
        )}
        {state.phase === 'pending-approval' && (
          <>
            <span className="tma-h3">Waiting for approval</span>
            <span className="tma-body-sm tma-muted">An owner of the GitHub organization must approve the install. When they do, start again from Add agent.</span>
            <div>
              <ButtonLink variant="secondary" href="/agents/new">
                Back to Add agent
              </ButtonLink>
            </div>
          </>
        )}
        {state.phase === 'error' && (
          <>
            <span className="tma-h3" data-testid="callback-error-title">Could not connect GitHub</span>
            <span className="tma-field__error" role="alert">{state.message}</span>
            <div className="tma-row" style={{ gap: 12 }}>
              <ButtonLink variant="primary" href="/agents/new">
                Try again
              </ButtonLink>
              <Button variant="secondary" onClick={() => navigate('/agents')}>
                Back to agents
              </Button>
            </div>
          </>
        )}
      </Card>
    </main>
  )
}
