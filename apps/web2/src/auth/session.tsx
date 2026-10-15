import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { API_URL } from '../config'
import { loginWithDfl } from './dflFederation'
import type { TmaSession, TmaUser } from './exchangeDflToken'
import { clearStoredSession, loadSession, saveSession } from './sessionStorage'

export interface SessionContextValue {
  user: TmaUser | null
  token: string | null
  /** Store a new session (after the DFL exchange). */
  setSession: (session: TmaSession) => void
  /** Clear the session. */
  logout: () => void
  /** `fetch` against the TMA API. Adds the bearer token. On 401: clears the session and re-federates. */
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>
}

const SessionContext = createContext<SessionContextValue | null>(null)

const defaultRedirect = (url: string) => window.location.assign(url)

export function SessionProvider({
  children,
  redirect = defaultRedirect,
  apiUrl = API_URL,
}: {
  children: ReactNode
  /** Where the browser goes on re-federation. A test replaces it to observe the target. */
  redirect?: (url: string) => void
  apiUrl?: string
}) {
  const [session, setSessionState] = useState<TmaSession | null>(() => loadSession())

  const setSession = useCallback((next: TmaSession) => {
    saveSession(next)
    setSessionState(next)
  }, [])

  const logout = useCallback(() => {
    clearStoredSession()
    setSessionState(null)
  }, [])

  const token = session?.token ?? null

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      if (token) headers.set('Authorization', `Bearer ${token}`)
      const res = await fetch(`${apiUrl}${path}`, { ...init, headers })
      if (res.status === 401) {
        clearStoredSession()
        setSessionState(null)
        loginWithDfl(`${window.location.pathname}${window.location.search}`, redirect)
      }
      return res
    },
    [token, apiUrl, redirect],
  )

  const value = useMemo<SessionContextValue>(
    () => ({ user: session?.user ?? null, token, setSession, logout, apiFetch }),
    [session, token, setSession, logout, apiFetch],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
