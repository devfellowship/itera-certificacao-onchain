/**
 * "Login with DFL" callback. The DFL handoff redirects here with the DFL token in the URL FRAGMENT:
 *   /auth/dfl/callback#dfl_token=<JWT>&next=/
 * A fragment (not a query) keeps the token out of server logs and Referer headers.
 * This page is the ONLY reader of that fragment. It clears the address bar BEFORE the network call.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loginWithDfl } from '../auth/dflFederation'
import { exchangeDflToken } from '../auth/exchangeDflToken'
import { safeInternalPath } from '../auth/safeInternalPath'
import { useSession } from '../auth/session'

export function readDflFragment(hash: string): { token: string | null; next: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  return { token: params.get('dfl_token'), next: safeInternalPath(params.get('next'), '/') }
}

export function DflCallbackPage() {
  const navigate = useNavigate()
  const { setSession } = useSession()
  const [failed, setFailed] = useState(false)
  const ran = useRef(false)

  useEffect(() => {
    // StrictMode runs effects twice in dev. The token is single use, so exchange it once.
    if (ran.current) return
    ran.current = true

    const { token, next } = readDflFragment(window.location.hash)
    // Clear the fragment first, before any network call.
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    } catch {
      /* ignore */
    }
    if (!token) {
      setFailed(true)
      return
    }
    void exchangeDflToken(token).then((result) => {
      if (result.ok) {
        setSession(result.session)
        navigate(next, { replace: true })
      } else {
        setFailed(true)
      }
    })
  }, [navigate, setSession])

  if (failed) {
    return (
      <main className="w2-shell">
        <h1>Could not sign in with DFL</h1>
        <p className="w2-lead" role="alert" data-testid="dfl-callback-error">
          The sign-in did not finish. The DFL token was missing or the server refused it. Try again.
        </p>
        <button type="button" className="w2-btn" data-testid="dfl-callback-retry" onClick={() => loginWithDfl('/')}>
          Try again
        </button>
      </main>
    )
  }

  return (
    <main className="w2-shell">
      <p className="w2-lead" role="status" data-testid="dfl-callback-loading">
        Signing you in…
      </p>
    </main>
  )
}
