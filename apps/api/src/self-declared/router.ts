/**
 * POST /self-declared-results[?dry_run=1] — the one door for a result that TMA did not run (plan
 * 20261026-tma-local-runner-and-self-declared-results, §1, ADR-1; task L3).
 *
 *   auth      a TMA session of a `dfl` principal. `siws` → 403 self_declared_dfl_only (web3 results carry proofs).
 *   body      tma-local-result/1 (schemas/local-result.schema.json) or tma-local-result/2 (schemas/local-result-
 *             v2.schema.json, plan 20261112-tma-c4-result-store-trajectory-upload, T3): numbers, digests and
 *             identifiers only. parseAnyLocalResultText picks the version by `format`. At most 4 MiB on THIS
 *             route, and at most 1 MiB for a v1 body (413 above). Unknown key → 400 unknown_key with its path.
 *   checks    agent of the caller (404) → known model (400) → task (404 / 409) → [v2: case 409 case_conflict,
 *             variant 409 variant_conflict / baseline_exists] → daily cap (429). store.ts.
 *   answer    v1: 201 inserted | 200 updated | 200 unchanged, with evaluation_id, run_id, result_origin, url
 *             (unchanged). v2: the same, plus case_id, variant_id, run_ids and runs {inserted, updated,
 *             unchanged}; run_id is the first run. dry_run=1: every check and write, then a rollback.
 *   not ready 503 schema_not_ready while db/migrations/0021 (v1, v2) or 0023 (v2) is not applied (nothing is
 *             written). A v1 upload never touches a 0023 table, so it keeps working before 0023.
 *
 * Mounted BEFORE the global express.json() (100 kB limit) so this route has its own 4 MiB text parser.
 */
import express, { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { LOCAL_RESULT_V2_MAX_BYTES, parseAnyLocalResultText, type LocalResultIssue } from "@itera/contracts";
import { requirePrincipal } from "../auth/middleware.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { DEFAULT_SELF_DECLARED_PER_DAY, SelfDeclaredError, resultTenantFromEnv, type SelfDeclaredStore } from "./store.js";

export interface SelfDeclaredRouterDeps {
  store: SelfDeclaredStore;
  /** TMA_SELF_DECLARED_PER_DAY: new self-declared evaluations per principal per 24 h (default 50). */
  perDay?: number;
  /** Base URL of the web2 client, for the `url` of the answer. */
  web2BaseUrl?: string;
  /** TMA_RESULT_TENANT: the result-plane tenant of v2 rows (default devfellowship). */
  tenant?: string;
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
  const tenant = deps.tenant ?? resultTenantFromEnv();

  const dflOnly = (req: Request, res: Response, next: () => void) => {
    if (req.principal?.kind !== "dfl") {
      res.status(403).json({ error: "self_declared_dfl_only", message: "self-declared results take a Login with DFL session" });
      return;
    }
    next();
  };

  const refused = (res: Response, next: (e?: unknown) => void) => (e: unknown) => {
    if (e instanceof SelfDeclaredError) res.status(e.status).json({ error: e.code, message: e.message });
    else if (e instanceof SchemaNotReadyError) res.status(503).json({ error: "schema_not_ready", message: e.message });
    else next(e);
  };

  // Auth runs BEFORE the body is parsed: an anonymous or siws caller never makes the API read 4 MiB. The body
  // is read as text (any content type) so the contract decides: parseAnyLocalResultText refuses a text above
  // 4 MiB, a v1 text above 1 MiB, and a text that is not JSON.
  router.post(
    "/self-declared-results",
    requirePrincipal,
    dflOnly,
    express.text({ type: () => true, limit: LOCAL_RESULT_V2_MAX_BYTES }),
    (req, res, next) => {
      const text = typeof req.body === "string" ? req.body : "";
      const checked = parseAnyLocalResultText(text);
      if (!checked.ok) {
        const h = headline(checked.issues);
        if (h.code === "too_large") {
          res.status(413).json({ error: "payload_too_large", message: `the body ${h.message}` });
          return;
        }
        res.status(400).json({ error: h.code, path: h.path, message: h.message, issues: checked.issues.slice(0, 20) });
        return;
      }
      const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";
      if (checked.format === "tma-local-result/2") {
        deps.store
          .importResultV2(req.principal!.id, checked.value, { dryRun, perDay, tenant })
          .then((o) => {
            res.status(o.action === "inserted" && !dryRun ? 201 : 200).json({
              format: checked.format,
              evaluation_id: o.evaluationId,
              run_id: o.runIds[0] ?? null,
              run_ids: o.runIds,
              case_id: o.caseId,
              variant_id: o.variantId,
              runs: o.runs,
              action: o.action,
              outcome: o.outcome,
              result_origin: "self_declared",
              dry_run: dryRun,
              url: `${web2}/evaluations/${o.evaluationId}`,
            });
          })
          .catch(refused(res, next));
        return;
      }
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
        .catch(refused(res, next));
    },
  );

  // The body parser's own errors, as JSON (only for this route).
  const parseErrors: ErrorRequestHandler = (err, req, res, next) => {
    if (req.path !== "/self-declared-results") return next(err);
    const type = (err as { type?: string }).type;
    if (type === "entity.too.large") {
      res.status(413).json({ error: "payload_too_large", message: `the body is above ${LOCAL_RESULT_V2_MAX_BYTES} bytes` });
      return;
    }
    next(err);
  };
  router.use(parseErrors);
  return router;
}
