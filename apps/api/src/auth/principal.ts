import { AUTH_ADAPTERS } from "./adapters/index.js";
import type { Principal } from "./adapters/types.js";
import { verifySessionClaims } from "./session.js";

/**
 * Session token → principal.
 *
 * - `amr` absent (a token issued before the auth adapter seam): the `sub` must be a base58 address,
 *   and the principal is `siws`. Live web3 sessions stay valid across the deploy.
 * - `amr` = `siws` | `dfl`: the adapter of that kind must accept the `sub`.
 * - Anything else (unknown `amr`, a `sub` that does not match its kind) is rejected.
 */
export function verifyPrincipalToken(token: string, nowMs: number = Date.now()): Principal | null {
  const claims = verifySessionClaims(token, nowMs);
  if (!claims) return null;
  if (!("amr" in claims)) return AUTH_ADAPTERS.siws.principalFromSubject(claims.sub);
  if (claims.amr === "siws" || claims.amr === "dfl") return AUTH_ADAPTERS[claims.amr].principalFromSubject(claims.sub);
  return null;
}

/** Returns the principal id in the token, or null when the token is malformed, forged, or expired.
 * Kept with its original contract (a string) for the rate limiter and existing callers; use
 * `verifyPrincipalToken` for the kind. */
export function verifySessionToken(token: string, nowMs: number = Date.now()): string | null {
  return verifyPrincipalToken(token, nowMs)?.id ?? null;
}
