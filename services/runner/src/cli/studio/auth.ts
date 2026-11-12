// Login check of `tma studio serve` (plan 20261112-tma-c5-studio-area-web2, ADR-4, task C5-T11).
//
// How a TMA web session is signed (apps/api/src/auth/session.ts): an HS256 JWT, signed with the API's
// session secret, 24 h, sent as `Authorization: Bearer <token>`. Claims: `sub` (the principal id,
// `dfl:<uuid>` for a DFL login), `amr` (`dfl` | `siws`), `iat`, `exp`, `iss`. A CLI session (`tma login`)
// also carries `sid`; a web session has none.
//
// This service does NOT hold the session secret. The secret signs sessions: a copy on the content host
// could mint a session for any TMA user. So the signature is checked by the TMA API itself, on every
// call, through `GET /auth/me` with the caller's token (it also refuses a disabled account). Before that
// call, a local pre-check refuses what needs no network: no token, a malformed token, an expired token,
// a CLI session, and a principal that is not on this service's allow-list. After the call, the
// principal id that the API returns must be on the allow-list and equal the token's `sub`.
//
// The token is never logged and never put in an error body.

export type Introspect = (token: string) => Promise<{ status: number; body: Record<string, unknown> | null }>;

export interface AuthDeps {
  /** `GET /auth/me` of the TMA API with this bearer token. */
  introspect: Introspect;
  /** The principal ids (e.g. `dfl:<uuid>`) that may read. Empty = nobody. */
  allowPrincipals: ReadonlySet<string>;
  /** Clock, for the tests. */
  nowMs?: () => number;
}

export type AuthResult =
  | { ok: true; principal: string }
  /** `status` is the HTTP answer of the studio service; `reason` is a fixed code, safe to log and return. */
  | { ok: false; status: 401 | 403 | 503; reason: AuthRefusal };

export type AuthRefusal =
  | 'missing_token'
  | 'malformed_token'
  | 'expired_token'
  | 'cli_session_refused'
  | 'principal_not_allowed'
  | 'invalid_session'
  | 'account_refused'
  | 'auth_unavailable';

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

interface Claims {
  sub: string;
  exp: number;
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The local pre-check. It reads the claims WITHOUT checking the signature, so it can only refuse, never
 * accept: an accepted pre-check still needs the API answer.
 */
export function precheckToken(token: string, nowMs: number): { ok: true; claims: Claims } | { ok: false; reason: AuthRefusal } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed_token' };
  const header = decodePart(parts[0]!);
  const claims = decodePart(parts[1]!);
  if (!header || !claims || header.alg !== 'HS256') return { ok: false, reason: 'malformed_token' };
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return { ok: false, reason: 'malformed_token' };
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: 'expired_token' };
  // A CLI session can be revoked in the API database, which this service cannot read. Web sessions only.
  if ('sid' in claims) return { ok: false, reason: 'cli_session_refused' };
  return { ok: true, claims: { sub: claims.sub, exp: claims.exp } };
}

/** Check the login of one request. Called on every request that reads content. */
export async function checkLogin(authorization: string | string[] | undefined, deps: AuthDeps): Promise<AuthResult> {
  const token = bearerToken(authorization);
  if (!token) return { ok: false, status: 401, reason: 'missing_token' };
  const pre = precheckToken(token, (deps.nowMs ?? Date.now)());
  if (!pre.ok) return { ok: false, status: 401, reason: pre.reason };
  if (!deps.allowPrincipals.has(pre.claims.sub)) return { ok: false, status: 403, reason: 'principal_not_allowed' };
  let answer: Awaited<ReturnType<Introspect>>;
  try {
    answer = await deps.introspect(token);
  } catch {
    return { ok: false, status: 503, reason: 'auth_unavailable' };
  }
  if (answer.status === 401) return { ok: false, status: 401, reason: 'invalid_session' };
  if (answer.status === 403) return { ok: false, status: 403, reason: 'account_refused' };
  if (answer.status !== 200) return { ok: false, status: 503, reason: 'auth_unavailable' };
  const id = answer.body?.id;
  if (typeof id !== 'string' || id !== pre.claims.sub) return { ok: false, status: 401, reason: 'invalid_session' };
  if (!deps.allowPrincipals.has(id)) return { ok: false, status: 403, reason: 'principal_not_allowed' };
  return { ok: true, principal: id };
}

/** The introspection call: `GET <api>/auth/me` with the caller's token, 5 s timeout. */
export function apiIntrospect(apiBase: string, fetchImpl: typeof fetch = fetch): Introspect {
  return async (token) => {
    const res = await fetchImpl(`${apiBase}/auth/me`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    const text = await res.text().catch(() => '');
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = text ? (JSON.parse(text) as unknown) : null;
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };
}
