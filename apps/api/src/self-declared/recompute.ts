/**
 * POST /eval-results/recompute — recompute a DERIVED column of the caller's own stored rows (plan
 * 20261112-tma-c4-result-store-trajectory-upload, task C4-T10, acceptance 3: the back-fill of the hosted rows written
 * before migration 0024). Data repair goes through a route on the caller's identity, never through a migration
 * (CLAUDE.md "DDL vs DML"); the MCP tool `recompute_tma_derived_columns` calls this route with the caller's session.
 *
 *   auth      a TMA session (any principal).
 *   body      { column: "step_kind", dry_run?: boolean (default TRUE), scope?: "mine" | "all" (default "mine"),
 *             limit?: integer 1-20000 (default 5000) }. Closed: an unknown key is 400 unknown_key.
 *   column    step_kind: run_actions.step_kind of HOSTED runs (runs.result_origin = 'hosted'), from the stored tool and
 *             target with hostedStepKindOf (@itera/contracts, the same mapping the runner uses at write time). Only a
 *             NULL value is filled; a value that is already set is never changed, so a second call changes 0 rows.
 *             Uploaded (self-declared) steps are not touched: their tool names belong to the uploader's harness.
 *   scope     mine: the rows of runs whose owner_wallet is the caller. all: every owner, including runs with no owner;
 *             only a TMA ADMIN (ITERA_ADMIN_WALLETS, as the other /admin routes and the grader clean-up) may send it,
 *             else 403 admin_only.
 *   answer    200 { column, dry_run, scope, scanned, updated, remaining, by_kind: {read: n, ...} }. `scanned` = the NULL
 *             rows read (at most `limit`), `updated` = the rows written (0 on a dry run), `remaining` = the NULL rows of
 *             the scope after this call.
 *   not ready 503 schema_not_ready before db/migrations/0024 (the column does not exist).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { requirePrincipal } from "../auth/middleware.js";
import { envAdminWallets } from "./cleanup.js";
import { EVAL_META_MIGRATION } from "./store.js";

export const RECOMPUTE_COLUMNS = ["step_kind"] as const;
export type RecomputeColumn = (typeof RECOMPUTE_COLUMNS)[number];
export const RECOMPUTE_DEFAULT_LIMIT = 5000;
export const RECOMPUTE_MAX_LIMIT = 20000;

export interface RecomputeOutcome {
  scanned: number;
  updated: number;
  remaining: number;
  byKind: Record<string, number>;
}

export interface RecomputeStore {
  /** One transaction. `owner` null = every owner (admin scope). Fills only NULL values; dryRun rolls back. */
  recomputeStepKinds(owner: string | null, options: { dryRun: boolean; limit: number }): Promise<RecomputeOutcome>;
}

export interface RecomputeRouterDeps {
  store: RecomputeStore;
  /** False before 0024: the route answers 503 schema_not_ready. */
  ready: () => Promise<boolean>;
  /** Principals that may use scope "all". Default: ITERA_ADMIN_WALLETS. */
  adminWallets?: () => string[];
}

const BODY_KEYS = new Set(["column", "dry_run", "scope", "limit"]);

export function createRecomputeRouter(deps: RecomputeRouterDeps): Router {
  const router = Router();
  const adminWallets = deps.adminWallets ?? envAdminWallets;

  router.post("/eval-results/recompute", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null;
      const bad = (status: number, error: string, message: string, path?: string) =>
        void res.status(status).json(path === undefined ? { error, message } : { error, path, message });
      if (!body) return bad(400, "invalid_body", "the body must be a JSON object");
      const unknown = Object.keys(body).find((k) => !BODY_KEYS.has(k));
      if (unknown !== undefined) return bad(400, "unknown_key", `unknown key ${unknown}`, `/${unknown}`);
      if (!RECOMPUTE_COLUMNS.includes(body.column as RecomputeColumn)) {
        return bad(400, "invalid_column", `column must be one of ${RECOMPUTE_COLUMNS.join(", ")}`, "/column");
      }
      if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") return bad(400, "invalid_dry_run", "dry_run must be true or false");
      const dryRun = body.dry_run !== false;
      const scope = body.scope ?? "mine";
      if (scope !== "mine" && scope !== "all") return bad(400, "invalid_scope", "scope must be mine or all", "/scope");
      const limit = body.limit ?? RECOMPUTE_DEFAULT_LIMIT;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > RECOMPUTE_MAX_LIMIT) {
        return bad(400, "invalid_limit", `limit must be an integer from 1 to ${RECOMPUTE_MAX_LIMIT}`, "/limit");
      }
      const caller = req.principal!.id;
      if (scope === "all" && !adminWallets().includes(caller)) return bad(403, "admin_only", "scope all is for a TMA admin; scope mine covers your own runs");
      if (!(await deps.ready())) return bad(503, "schema_not_ready", `database schema is not migrated yet (needs db/migrations/${EVAL_META_MIGRATION})`);
      const out = await deps.store.recomputeStepKinds(scope === "all" ? null : caller, { dryRun, limit });
      res.json({ column: body.column, dry_run: dryRun, scope, scanned: out.scanned, updated: out.updated, remaining: out.remaining, by_kind: out.byKind });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
