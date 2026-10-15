import { Router } from "express";
import type { AuthAdapter, Principal } from "./types.js";

/**
 * Login with DFL (web2 client). STUB: task T5 of plan 20261015-testmyagent-web2-client implements
 * the exchange. Today `POST /auth/dfl/exchange` answers 501 and no `dfl` session is ever issued.
 */

const DFL_PRINCIPAL_RE = /^dfl:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDflPrincipalId(value: string): boolean {
  return DFL_PRINCIPAL_RE.test(value);
}

export const dflAdapter: AuthAdapter = {
  kind: "dfl",
  router() {
    const router = Router();
    router.post("/auth/dfl/exchange", (_req, res) => {
      res.status(501).json({ error: "not_implemented" });
    });
    return router;
  },
  principalFromSubject(sub: string): Principal | null {
    return isDflPrincipalId(sub) ? { id: sub, kind: "dfl" } : null;
  },
};
