/**
 * Exchange a DFL access token for a TestMyAgent session.
 * `POST {API}/auth/dfl/exchange {dflToken}` -> `{sessionToken, user:{id,email}}`.
 * Never throws. Never logs the token or the session token.
 */
import { API_URL } from '../config'

export interface TmaUser {
  id: string
  email: string
}

export interface TmaSession {
  token: string
  user: TmaUser
}

export type ExchangeResult =
  | { ok: true; session: TmaSession }
  | { ok: false; reason: 'network' | 'http' | 'invalid'; status?: number }

export async function exchangeDflToken(dflToken: string, apiUrl: string = API_URL): Promise<ExchangeResult> {
  let res: Response
  try {
    res = await fetch(`${apiUrl}/auth/dfl/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dflToken }),
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (res.status !== 200) return { ok: false, reason: 'http', status: res.status }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  const b = body as { sessionToken?: unknown; user?: { id?: unknown; email?: unknown } } | null
  if (
    !b ||
    typeof b.sessionToken !== 'string' ||
    !b.sessionToken ||
    typeof b.user?.id !== 'string' ||
    typeof b.user?.email !== 'string'
  ) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true, session: { token: b.sessionToken, user: { id: b.user.id, email: b.user.email } } }
}
