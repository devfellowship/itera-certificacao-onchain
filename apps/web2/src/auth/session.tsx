import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { API_URL } from '../config'
import { api, setSessionToken, setUnauthorizedHandler } from '../lib/api'
import type { Me } from '../lib/api'
import { initialsOf } from '../tma/ui'
import { loginWithDfl } from './dflFederation'
import type { TmaSession, TmaUser } from './exchangeDflToken'
import { clearStoredSession, loadSession, saveSession } from './sessionStorage'

export type SessionStatus = 'disconnected' | 'signed-in'

/** The fields that the apps/web screens read from `useSession()`. */
export interface Session {
  status: SessionStatus
  /** The principal `dfl:<uuid>` (the DFL user id). */
  wallet: string | null
  walletName: string | null
  me: Me | null
  error: string | null
  /** Starts Login with DFL and comes back to the current path. */
  signIn: () => void
  signOut: () => Promise<void>
  /** Replaces the profile after the settings page saves it (no refetch). */
  setMe: (me: Me) => void
}

export interface SessionContextValue extends Session {
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

function fallbackMe(id: string, email: string): Me {
  const letters = email.replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase()
  return { wallet: id, username: null, displayName: email || null, handle: null, avatarUrl: null, initials: letters || initialsOf(id) }
}

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
    setMe(null)
  }, [])

  const signIn = useCallback(
    () => loginWithDfl(`${window.location.pathname}${window.location.search}`, redirectRef.current),
    [],
  )
  const signOut = useCallback(async () => logout(), [logout])

  const token = session?.token ?? null

  // Install the token before any child effect fires a request (as apps/web does).
  setSessionToken(token)

  const [me, setMe] = useState<Me | null>(null)
  const userId = session?.user.id ?? null
  const userEmail = session?.user.email ?? null
  const redirectRef = useRef(redirect)
  redirectRef.current = redirect

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearStoredSession()
      setSessionState(null)
      setMe(null)
      loginWithDfl(`${window.location.pathname}${window.location.search}`, redirectRef.current)
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  useEffect(() => {
    if (!userId) {
      setMe(null)
      return
    }
    let live = true
    api
      .me()
      .then((m) => live && setMe(m))
      .catch(() => live && setMe(fallbackMe(userId, userEmail ?? '')))
    return () => {
      live = false
    }
  }, [userId, userEmail, token])

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
    () => ({
      user: session?.user ?? null,
      token,
      setSession,
      logout,
      apiFetch,
      status: session ? 'signed-in' : 'disconnected',
      wallet: userId,
      walletName: 'DFL',
      me: me ?? (userId ? fallbackMe(userId, userEmail ?? '') : null),
      error: null,
      signIn,
      signOut,
      setMe,
    }),
    [session, token, setSession, logout, apiFetch, userId, userEmail, me, signIn, signOut],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
