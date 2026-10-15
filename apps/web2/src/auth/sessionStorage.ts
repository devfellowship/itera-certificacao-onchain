import type { TmaSession } from './exchangeDflToken'

/** localStorage key of the TestMyAgent web2 session. */
export const SESSION_KEY = 'tma2.session'

export function loadSession(): TmaSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<TmaSession> | null
    if (s && typeof s.token === 'string' && s.token && typeof s.user?.id === 'string' && typeof s.user.email === 'string') {
      return { token: s.token, user: { id: s.user.id, email: s.user.email } }
    }
  } catch {
    /* storage blocked or bad JSON */
  }
  return null
}

export function saveSession(session: TmaSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    /* storage blocked: the session lives in memory only */
  }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* storage blocked */
  }
}
