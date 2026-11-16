import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { DflAuthConfig } from "../config.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import type { UsersStore } from "../domain/users-store.js";
import { verifyPrincipalToken } from "./principal.js";

/**
 * Member gate on every route (plan 20261112-tma-c6-judge-calibration, task C6-S13-GATE, Q-C6-S13 = A).
 *
 * `TMA_MIN_IAM_LEVEL` (default 0) was checked only at login (`POST /auth/dfl/exchange`) and on `GET /auth/me`.
 * A session minted before the level was raised, or by a login that did not read the level, kept full
 * access to the review queue, the runs and the labels for up to 24 h. This guard reads the level that the
 * login stored on the `users` row and refuses a `dfl` principal below the minimum with
 * `403 {error: "iam_level_too_low"}` on every route, any method but OPTIONS.
 *
 * - `minIamLevel` 0 (the default) skips the lookup: no query, no change of behaviour.
 * - `siws` principals and requests without a valid session skip it (the route answers 401 itself).
 * - A principal without a `users` row, or with a null level, is refused with `401 {error: "iam_level_unknown"}`
 *   (fail closed). A null level means the login did not read the level: the session predates the gate (before the
 *   gate, the exchange stored no level). 401, not 403: the web client clears a session on 401 and signs in again, and
 *   that new exchange reads the level from DFL and stores it. A 403 here left a member on an error page until the
 *   24 h session ran out (incident 2026-11-16, the S13 review page of a superadmin whose last login was before the gate).
 * - A PASS is cached per principal (30 s by default). A refusal is never cached, so a person who signs in again (the
 *   exchange stores the new level) is let in at once; a refused principal costs one primary-key read per request, behind
 *   the rate limiters.
 * - When the users store fails, the request is refused with 503 (fail closed) and nothing is cached.
 *
 * Mounted once in app.ts, before the routers, so no route can forget it.
 */

export const IAM_LEVEL_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;

export interface IamLevelGuardOptions {
  users: UsersStore;
  /** Read per request. Defaults to `dflAuthConfigFromEnv()` in app.ts. */
  config: () => Pick<DflAuthConfig, "minIamLevel">;
  ttlMs?: number;
  now?: () => number;
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((req.get("authorization") ?? "").trim());
  return match ? match[1]!.trim() : null;
}

export function createIamLevelGuard(options: IamLevelGuardOptions): RequestHandler {
  const { users } = options;
  const ttlMs = options.ttlMs ?? IAM_LEVEL_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { level: number; expiresAt: number }>();

  /** The stored level, or null when no login stored one (no row, or a null level). */
  async function levelOf(principalId: string, min: number): Promise<number | null> {
    const at = now();
    const hit = cache.get(principalId);
    if (hit && hit.expiresAt > at && hit.level >= min) return hit.level;
    const row = await users.get(principalId);
    const level = row?.iamLevel ?? null;
    if (level !== null && level >= min) {
      if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
      cache.set(principalId, { level, expiresAt: at + ttlMs });
    } else {
      cache.delete(principalId);
    }
    return level;
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "OPTIONS") {
      next();
      return;
    }
    let min: number;
    try {
      min = options.config().minIamLevel;
    } catch {
      // An invalid TMA_MIN_IAM_LEVEL fails the boot (config.ts); a throw here is a bug, so refuse.
      res.status(503).json({ error: "iam_config_invalid" });
      return;
    }
    if (!(min > 0)) {
      next();
      return;
    }
    const token = bearer(req);
    let principal;
    try {
      principal = token ? verifyPrincipalToken(token) : null;
    } catch {
      // ITERA_SESSION_SECRET unset: no session can be valid, the route answers 401 itself.
      principal = null;
    }
    if (!principal || principal.kind !== "dfl") {
      next();
      return;
    }
    levelOf(principal.id, min).then(
      (level) => {
        if (level === null) res.status(401).json({ error: "iam_level_unknown" });
        else if (level < min) res.status(403).json({ error: "iam_level_too_low" });
        else next();
      },
      (e: unknown) => {
        res.status(503).json({ error: e instanceof SchemaNotReadyError ? "schema_not_ready" : "users_store_unavailable" });
      },
    );
  };
}
