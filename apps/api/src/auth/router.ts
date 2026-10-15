import { Router } from "express";
import { dflAuthConfigFromEnv, type DflAuthConfig } from "../config.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { createDflAdapter, type DflAuthDeps } from "./adapters/dfl.js";
import { siwsAdapter } from "./adapters/siws.js";
import type { AuthAdapter } from "./adapters/types.js";
import { requirePrincipal } from "./middleware.js";

export interface AuthRouterOptions {
  /** Defaults to SIWS + DFL (the DFL adapter built from `dfl`). */
  adapters?: readonly AuthAdapter[];
  /** The DFL adapter deps (users store, config, fetch). Also read by `GET /auth/me`. */
  dfl?: DflAuthDeps;
}

/**
 * The login routes of every adapter, plus `GET /auth/me`.
 *
 * `GET /auth/me` → `{id, kind, wallet, email?}`. `wallet` equals `id` (ADR-3 alias, kept for the web3
 * client). For a `dfl` principal with a `users` row: `email`, and `403 account_disabled` when the row
 * is disabled, `403 iam_level_too_low` when `TMA_MIN_IAM_LEVEL` is above the level stored at login.
 */
export function createAuthRouter(options: AuthRouterOptions = {}): Router {
  const router = Router();
  const adapters = options.adapters ?? [siwsAdapter, createDflAdapter(options.dfl)];
  for (const adapter of adapters) router.use(adapter.router());
  const readConfig: () => DflAuthConfig = options.dfl?.config ?? (() => dflAuthConfigFromEnv());
  const users = options.dfl?.users;

  router.get("/auth/me", requirePrincipal, async (req, res) => {
    const principal = req.principal!;
    const base = { id: principal.id, kind: principal.kind, wallet: principal.id };
    if (principal.kind !== "dfl" || !users) {
      res.json(base);
      return;
    }
    let row;
    try {
      row = await users.get(principal.id);
    } catch (e) {
      res.status(503).json({ error: e instanceof SchemaNotReadyError ? "schema_not_ready" : "users_store_unavailable" });
      return;
    }
    if (!row) {
      res.json(base);
      return;
    }
    if (row.disabled) {
      res.status(403).json({ error: "account_disabled" });
      return;
    }
    const { minIamLevel } = readConfig();
    if (minIamLevel > 0 && (row.iamLevel ?? 0) < minIamLevel) {
      res.status(403).json({ error: "iam_level_too_low" });
      return;
    }
    res.json(row.email ? { ...base, email: row.email } : base);
  });

  return router;
}
