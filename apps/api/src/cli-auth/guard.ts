/**
 * CLI session guard (task L5). A CLI session is a normal 24 h TMA session with a `sid` claim (the
 * `cli_device_codes.session_id` of its device login). This middleware runs once in app.ts, before every
 * router, and refuses a CLI session that its owner revoked, or whose row is gone:
 *
 *   401 {error: "cli_session_revoked"}
 *
 * - A request without a valid session, or with a web session (no `sid`), skips the lookup: it costs no
 *   query, and the route answers as before.
 * - A valid `sid` is cached for CLI_SESSION_CACHE_TTL_MS (10 s). A revocation through this process clears
 *   the cache at once (`forget`); on another process it takes effect within one TTL.
 * - The `sid` row must belong to the token's `sub`. A mismatch is treated as revoked.
 * - When the store fails, the request is refused with 503 (fail closed) and nothing is cached.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { verifySessionClaims } from "../auth/session.js";
import type { CliAuthStore } from "./store.js";

export const CLI_SESSION_CACHE_TTL_MS = 10_000;
const MAX_CACHE_ENTRIES = 10_000;

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((req.get("authorization") ?? "").trim());
  return match ? match[1]!.trim() : null;
}

export interface CliSessionGuard extends RequestHandler {
  /** Drops the cached answer for one session (called after a revoke). */
  forget(sessionId: string): void;
}

export interface CliSessionGuardOptions {
  store: Pick<CliAuthStore, "session">;
  ttlMs?: number;
  now?: () => number;
}

export function createCliSessionGuard(options: CliSessionGuardOptions): CliSessionGuard {
  const { store } = options;
  const ttlMs = options.ttlMs ?? CLI_SESSION_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { principal: string; expiresAt: number }>();

  const guard = ((req: Request, res: Response, next: NextFunction): void => {
    const token = bearer(req);
    let claims;
    try {
      claims = token ? verifySessionClaims(token) : null;
    } catch {
      // ITERA_SESSION_SECRET unset: no session can be valid, the route answers 401 itself.
      claims = null;
    }
    if (!claims?.sid) {
      next();
      return;
    }
    const sid = claims.sid;
    const sub = claims.sub;
    const at = now();
    const hit = cache.get(sid);
    if (hit && hit.expiresAt > at) {
      if (hit.principal === sub) next();
      else res.status(401).json({ error: "cli_session_revoked", message: "this CLI session was revoked: run tma login again" });
      return;
    }
    store.session(sid).then(
      (row) => {
        if (!row || row.revoked || row.principal !== sub) {
          cache.delete(sid);
          res.status(401).json({ error: "cli_session_revoked", message: "this CLI session was revoked: run tma login again" });
          return;
        }
        if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
        cache.set(sid, { principal: row.principal, expiresAt: at + ttlMs });
        next();
      },
      (e: unknown) => {
        res.status(503).json({ error: e instanceof SchemaNotReadyError ? "schema_not_ready" : "cli_sessions_unavailable" });
      },
    );
  }) as CliSessionGuard;
  guard.forget = (sessionId: string) => {
    cache.delete(sessionId);
  };
  return guard;
}
