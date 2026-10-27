/**
 * Owner-only guard of the run routes for self-declared runs (plan 20261026-tma-local-runner-and-self-
 * declared-results, Q4 = C, TG 23676; task L3). Mounted BEFORE the runs, feedback and proofs routers,
 * so their files stay unchanged:
 *
 *   GET  /runs/:id, GET /runs/:id/actions   a self-declared run answers 404 to anyone but its owner
 *                                           (the same answer as an unknown run: its existence does
 *                                           not leak). GET /runs/:id gets `resultOrigin` in its body.
 *   GET  /runs/:id/artifacts                L17a, owner-only routes: the same 404 for a non-owner. An
 *   GET  /runs/:id/artifacts/file           anonymous call passes through, so the router answers its
 *                                           own 401 (a 404 here would tell a self-declared id apart).
 *                                           No `resultOrigin` injection: the router sets it itself.
 *   POST /runs/:id/publish                  409 self_declared_run: TMA does not attest a run that it
 *   POST /runs/:id/start-signature          did not run (no proof, no on-chain memo), and its owner's
 *   POST /runs/:id/feedback                 feedback must not move the public task reputation.
 *
 * Before 0021 the lookup answers null (no column, so no self-declared run) and every request passes.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { optionalPrincipal } from "../auth/middleware.js";
import { hasSelfDeclaredSchema } from "../domain/schema-features.js";

export type RunOrigin = { ownerWallet: string | null; resultOrigin: "hosted" | "self_declared" };

export interface RunOriginLookup {
  originOf(runId: string): Promise<RunOrigin | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PgRunOriginLookup implements RunOriginLookup {
  constructor(private readonly pool: () => Pool) {}

  async originOf(runId: string): Promise<RunOrigin | null> {
    const pool = this.pool();
    if (!(await hasSelfDeclaredSchema(pool))) return null;
    const { rows } = await pool.query(`select owner_wallet, result_origin from public.runs where id = $1`, [runId]);
    const r = rows[0];
    if (!r) return null;
    return { ownerWallet: r.owner_wallet ?? null, resultOrigin: r.result_origin === "self_declared" ? "self_declared" : "hosted" };
  }
}

export function createSelfDeclaredRunGuard(lookup: RunOriginLookup): Router {
  const router = Router();

  const read = (addOrigin: boolean, anonymousPasses = false) => async (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return next();
    if (anonymousPasses && !req.wallet) return next();
    try {
      const o = await lookup.originOf(id);
      if (o?.resultOrigin === "self_declared" && (!req.wallet || req.wallet !== o.ownerWallet)) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      if (addOrigin) {
        const resultOrigin = o?.resultOrigin ?? "hosted";
        const json = res.json.bind(res);
        res.json = (body: unknown) =>
          json(body && typeof body === "object" && !Array.isArray(body) && !("error" in body) ? { ...body, resultOrigin } : body);
      }
      next();
    } catch (e) {
      next(e);
    }
  };

  const write = async (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return next();
    try {
      const o = await lookup.originOf(id);
      if (o?.resultOrigin === "self_declared") {
        res.status(409).json({ error: "self_declared_run", message: "a self-declared run has no proof and no public feedback: TestMyAgent did not run it" });
        return;
      }
      next();
    } catch (e) {
      next(e);
    }
  };

  router.get("/runs/:id", optionalPrincipal, read(true));
  router.get("/runs/:id/actions", optionalPrincipal, read(false));
  router.get(["/runs/:id/artifacts", "/runs/:id/artifacts/file"], optionalPrincipal, read(false, true));
  router.post(["/runs/:id/publish", "/runs/:id/start-signature", "/runs/:id/feedback"], write);
  return router;
}
