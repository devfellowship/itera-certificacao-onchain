/**
 * POST /self-declared-results[?dry_run=1] — the one door for a result that TMA did not run (plan
 * 20261026-tma-local-runner-and-self-declared-results, §1, ADR-1; task L3).
 *
 *   auth      a TMA session of a `dfl` principal. `siws` → 403 self_declared_dfl_only (web3 results carry proofs).
 *   body      tma-local-result/1 (packages/contracts/schemas/local-result.schema.json): numbers and identifiers
 *             only, at most 1 MiB on THIS route (413 above). Unknown key → 400 unknown_key with its JSON path.
 *   checks    agent of the caller (404) → known model (400) → task (404 / 409) → daily cap (429). store.ts.
 *   answer    201 inserted | 200 updated | 200 unchanged, with evaluation_id, run_id, result_origin, url.
 *             dry_run=1: every check and write, then a rollback; 200 with the same summary.
 *   not ready 503 schema_not_ready while db/migrations/0021 is not applied (nothing is written).
 *
 * Mounted BEFORE the global express.json() (100 kB limit) so this route has its own 1 MiB parser.
 */
import express, { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { LOCAL_RESULT_MAX_BYTES, validateLocalResult, type LocalResultIssue } from "@itera/contracts";
import { requirePrincipal } from "../auth/middleware.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { DEFAULT_SELF_DECLARED_PER_DAY, SelfDeclaredError, type SelfDeclaredStore } from "./store.js";

export interface SelfDeclaredRouterDeps {
  store: SelfDeclaredStore;
  /** TMA_SELF_DECLARED_PER_DAY: new self-declared evaluations per principal per 24 h (default 50). */
  perDay?: number;
  /** Base URL of the web2 client, for the `url` of the answer. */
  web2BaseUrl?: string;
}

export const DEFAULT_WEB2_BASE_URL = "https://testmyagent.com";

export function selfDeclaredPerDayFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TMA_SELF_DECLARED_PER_DAY);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_SELF_DECLARED_PER_DAY;
}

/** The issue code that the answer names: an unknown key first (the leak class), else the first issue. */
function headline(issues: LocalResultIssue[]): LocalResultIssue {
  return issues.find((i) => i.code === "unknown_key") ?? issues[0]!;
}

export function createSelfDeclaredRouter(deps: SelfDeclaredRouterDeps): Router {
  const router = Router();
  const perDay = deps.perDay ?? DEFAULT_SELF_DECLARED_PER_DAY;
  const web2 = (deps.web2BaseUrl ?? DEFAULT_WEB2_BASE_URL).replace(/\/+$/, "");

  const dflOnly = (req: Request, res: Response, next: () => void) => {
    if (req.principal?.kind !== "dfl") {
      res.status(403).json({ error: "self_declared_dfl_only", message: "self-declared results take a Login with DFL session" });
      return;
    }
    next();
  };

  // Auth runs BEFORE the body is parsed: an anonymous or siws caller never makes the API read 1 MiB.
  router.post(
    "/self-declared-results",
    requirePrincipal,
    dflOnly,
    express.json({ limit: LOCAL_RESULT_MAX_BYTES }),
    (req, res, next) => {
      const checked = validateLocalResult(req.body);
      if (!checked.ok) {
        const h = headline(checked.issues);
        res.status(400).json({ error: h.code, path: h.path, message: h.message, issues: checked.issues.slice(0, 20) });
        return;
      }
      const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";
      deps.store
        .importResult(req.principal!.id, checked.value, { dryRun, perDay })
        .then((o) => {
          res.status(o.action === "inserted" && !dryRun ? 201 : 200).json({
            evaluation_id: o.evaluationId,
            run_id: o.runId,
            action: o.action,
            outcome: o.outcome,
            result_origin: "self_declared",
            dry_run: dryRun,
            url: `${web2}/evaluations/${o.evaluationId}`,
          });
        })
        .catch((e) => {
          if (e instanceof SelfDeclaredError) res.status(e.status).json({ error: e.code, message: e.message });
          else if (e instanceof SchemaNotReadyError) res.status(503).json({ error: "schema_not_ready", message: e.message });
          else next(e);
        });
    },
  );

  // The body parser's own errors, as JSON (only for this route).
  const parseErrors: ErrorRequestHandler = (err, req, res, next) => {
    if (req.path !== "/self-declared-results") return next(err);
    const type = (err as { type?: string }).type;
    if (type === "entity.too.large") {
      res.status(413).json({ error: "payload_too_large", message: `the body is above ${LOCAL_RESULT_MAX_BYTES} bytes` });
      return;
    }
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: "not_json", message: "the body is not JSON" });
      return;
    }
    next(err);
  };
  router.use(parseErrors);
  return router;
}
