import type { NextFunction, Request, RequestHandler, Response } from "express";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import type { UsersStore } from "../domain/users-store.js";
import { verifyPrincipalToken } from "./principal.js";

/**
 * Kill switch for the free path (plan 20261015-testmyagent-web2-client, ADR-9, task T10).
 *
 * `users.disabled = true` gives `403 {error: "account_disabled"}` on every write route (any method but
 * GET, HEAD, OPTIONS) for that `dfl` principal. Public and read routes keep working.
 *
 * - `siws` principals and requests without a valid session skip the lookup: the web3 flow is unchanged
 *   and costs no query.
 * - The lookup is cached per principal (30 s by default) so a burst of writes costs one query. A ban
 *   takes effect within one TTL.
 * - A principal without a `users` row is not disabled.
 * - When the users store fails, the write is refused with 503 (fail closed) and nothing is cached.
 *
 * Mounted once in app.ts, before the routers, so no route can forget it.
 */

export const ACCOUNT_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AccountGuardOptions {
  users: UsersStore;
  ttlMs?: number;
  now?: () => number;
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((req.get("authorization") ?? "").trim());
  return match ? match[1]!.trim() : null;
}

export function createAccountGuard(options: AccountGuardOptions): RequestHandler {
  const { users } = options;
  const ttlMs = options.ttlMs ?? ACCOUNT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { disabled: boolean; expiresAt: number }>();

  async function isDisabled(principalId: string): Promise<boolean> {
    const at = now();
    const hit = cache.get(principalId);
    if (hit && hit.expiresAt > at) return hit.disabled;
    const row = await users.get(principalId);
    const disabled = row?.disabled === true;
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(principalId, { disabled, expiresAt: at + ttlMs });
    return disabled;
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    if (READ_METHODS.has(req.method)) {
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
    isDisabled(principal.id).then(
      (disabled) => {
        if (disabled) res.status(403).json({ error: "account_disabled" });
        else next();
      },
      (e: unknown) => {
        res.status(503).json({ error: e instanceof SchemaNotReadyError ? "schema_not_ready" : "users_store_unavailable" });
      },
    );
  };
}
