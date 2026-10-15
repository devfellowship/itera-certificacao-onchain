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
): { token: string; expiresAt: string } {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: subject, amr, iat, exp, iss: "itera-api" }));
  const signature = b64url(hmac(`${header}.${payload}`, sessionSecret()));
  return { token: `${header}.${payload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export interface SessionClaims {
  sub: string;
  /** Absent on tokens issued before the auth adapter seam. */
  amr?: unknown;
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
    };
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 <= nowMs) return null;
    return "amr" in claims ? { sub: claims.sub, amr: claims.amr } : { sub: claims.sub };
  } catch {
    return null;
  }
}
