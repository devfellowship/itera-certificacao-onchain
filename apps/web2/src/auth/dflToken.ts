/**
 * The DFL access token, kept for ONE reader: the "Melhorias" launcher (`improvements/`).
 *
 * The TMA API session (`sessionStorage.ts`) is not a DFL token. The dfl-improvements service and the DFL
 * `upload-file` function only accept the user's DFL Supabase JWT, so the launcher needs it. `DflCallbackPage`
 * saves it here before the exchange. It lives in `sessionStorage` (this tab only, gone when the tab closes)
 * and a Supabase access token expires on its own (about 1 h). No other module reads it. It is never logged.
 */
const KEY = 'tma2.dfl_token'
/** Seconds before `exp` at which the token already counts as expired. */
const SKEW_SECONDS = 30

/** The `exp` claim (seconds since the epoch) of a JWT, or null when the payload is not readable. */
export function jwtExpiry(token: string): number | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='))
    const exp = (JSON.parse(json) as { exp?: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
  } catch {
    return null
  }
}

export function saveDflToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token)
  } catch {
    /* storage blocked: the launcher stays hidden */
  }
}

/** The stored token, or null when none is stored or it is expired (or has no readable `exp`). */
export function loadDflToken(nowMs: number = Date.now()): string | null {
  try {
    const token = sessionStorage.getItem(KEY)
    if (!token) return null
    const exp = jwtExpiry(token)
    if (exp === null || exp * 1000 <= nowMs + SKEW_SECONDS * 1000) {
      sessionStorage.removeItem(KEY)
      return null
    }
    return token
  } catch {
    return null
  }
}

export function clearDflToken(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* storage blocked */
  }
}
