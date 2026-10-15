import { Router } from "express";
import { AUTH_ADAPTERS } from "./adapters/index.js";
import type { AuthAdapter } from "./adapters/types.js";
import { requireWallet } from "./middleware.js";

/** The login routes of every adapter, plus `GET /auth/me`. */
export function createAuthRouter(adapters: readonly AuthAdapter[] = Object.values(AUTH_ADAPTERS)): Router {
  const router = Router();
  for (const adapter of adapters) router.use(adapter.router());

  router.get("/auth/me", requireWallet, (req, res) => {
    res.json({ wallet: req.wallet });
  });

  return router;
}
