import { createHmac, timingSafeEqual } from "node:crypto";
import { requiredSecret } from "../config.js";
import type { PrincipalKind } from "./adapters/types.js";

/**
 * Session tokens: an HS256 JWT signed with `ITERA_SESSION_SECRET`, 24h, sent as
 * `Authorization: Bearer <token>`. No dependency.
 *
 * Claims: `sub` (the principal id), `amr` (`siws` | `dfl`, the adapter that authenticated the
 * principal), `iat`, `exp`, `iss`. Tokens issued before the auth adapter seam have no `amr`; see
 * `principal.ts` for how they are read.
 *
 * A CLI session (the device login of `tma login`, cli-auth/) also has `sid`: the uuid of its
 * `cli_device_codes` row. The CLI session guard (cli-auth/guard.ts) refuses a token whose `sid` row is
 * revoked or gone. A web session has no `sid`.
 */

export const SESSION_TTL_SECONDS = 24 * 60 * 60;

function sessionSecret(): string {
  return requiredSecret("ITERA_SESSION_SECRET");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function issueSessionToken(
  subject: string,
  nowMs: number = Date.now(),
  amr: PrincipalKind = "siws",
  sid?: string,
): { token: string; expiresAt: string } {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = sid ? { sub: subject, amr, sid, iat, exp, iss: "itera-api" } : { sub: subject, amr, iat, exp, iss: "itera-api" };
  const payload = b64url(JSON.stringify(claims));
  const signature = b64url(hmac(`${header}.${payload}`, sessionSecret()));
  return { token: `${header}.${payload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export interface SessionClaims {
  sub: string;
  /** Absent on tokens issued before the auth adapter seam. */
  amr?: unknown;
  /** The CLI session id (cli_device_codes.session_id). Present only on a CLI session. */
  sid?: string;
}

/** Returns the claims of a token with a valid signature that has not expired, else null. Does not
 * validate `sub` — `principal.ts` does. */
export function verifySessionClaims(token: string, nowMs: number = Date.now()): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = hmac(`${header}.${payload}`, sessionSecret());
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const head = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: unknown };
    if (head.alg !== "HS256") return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      exp?: unknown;
      amr?: unknown;
      sid?: unknown;
    };
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 <= nowMs) return null;
    // A `sid` that is present but not a string is a malformed token, not a web session.
    if ("sid" in claims && typeof claims.sid !== "string") return null;
    const out: SessionClaims = "amr" in claims ? { sub: claims.sub, amr: claims.amr } : { sub: claims.sub };
    if (typeof claims.sid === "string") out.sid = claims.sid;
    return out;
  } catch {
    return null;
  }
}
