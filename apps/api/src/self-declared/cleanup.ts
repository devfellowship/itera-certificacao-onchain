/**
 * POST /eval-results/cleanup — the one door that deletes eval cases, agent variants and grader versions that
 * nothing references (plan 20261112-tma-c4-result-store-trajectory-upload, task C4-T13; Q-C4-2 `c76e9a9d` = A,
 * Tainan, 2026-11-12). Before it, no route could delete these rows: DELETE /evaluations/:id removes the runs, and the
 * case, the variants and the grader versions of a deleted evaluation stayed behind.
 *
 *   auth      a TMA session (any principal). The rows that it may delete are the caller's own (see "owner").
 *   body      { dry_run?: boolean (default TRUE), case_ids?: uuid[], variant_ids?: uuid[], grader_version_ids?: uuid[] }.
 *             Closed: an unknown key is 400 unknown_key. `dry_run` must be the boolean false to delete; any other
 *             value but true (and absent) is 400 invalid_dry_run.
 *   listing   no id list at all = list the rows that the caller could delete. dry_run=false needs at least one id
 *             (400 ids_required): a delete is always by explicit id, never "everything unreferenced".
 *   owner     case and variant: `owner_wallet` = the caller. A row of another principal answers `not_found`, the same
 *             as an unknown id. Grader version: the registry has NO owner column (0023: one row per tenant, id@semver and
 *             code digest, created on first use), so the rule is tenant + "bare" (no judge or calibration field) +
 *             unreferenced; a bare registry row is recreated by the next upload that uses it, so nothing is lost.
 *   refused   referenced_by_runs (case, variant: some run points at it), baseline_of_case (variant: a case that stays
 *             has it as its baseline), referenced_by_grader_results (grader version), grader_has_calibration, not_found.
 *   answer    200 { dry_run, deleted, selected: {cases, variants, grader_versions}, refused: [{kind, id, reason, detail}] }.
 *             `selected` is the exact list that was deleted (dry_run=false) or would be (dry_run=true).
 *
 * The decision lives in `planCleanup` (pure, tested on its own). The store reads the facts inside one transaction
 * with the candidate rows locked, applies the plan, and deletes with the same guards in SQL as a second check.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { requirePrincipal } from "../auth/middleware.js";
import { EVAL_RESULTS_MIGRATION, resultTenantFromEnv } from "./store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLEANUP_MAX_IDS = 200;

export type CleanupKind = "case" | "variant" | "grader_version";
export type CleanupReason =
  | "not_found"
  | "referenced_by_runs"
  | "baseline_of_case"
  | "referenced_by_grader_results"
  | "grader_has_calibration";

/** The rows that the caller can see: its own cases and variants, and the tenant's grader versions. */
export interface CleanupFacts {
  cases: Array<{ id: string; caseKey: string; runCount: number }>;
  /** `baselineOfCaseIds`: every case (of any owner) that has this variant as its baseline. */
  variants: Array<{ id: string; label: string; runCount: number; baselineOfCaseIds: string[] }>;
  graders: Array<{ id: string; graderId: string; semver: string; resultCount: number; calibrated: boolean }>;
}

/** `null` = the list was not given. All three null = a listing. */
export interface CleanupSelection {
  caseIds: string[] | null;
  variantIds: string[] | null;
  graderVersionIds: string[] | null;
}

export interface CleanupRefusal {
  kind: CleanupKind;
  id: string;
  reason: CleanupReason;
  detail: Record<string, unknown>;
}

export interface CleanupPlan {
  listing: boolean;
  cases: Array<{ id: string; caseKey: string }>;
  variants: Array<{ id: string; label: string }>;
  graderVersions: Array<{ id: string; graderId: string; semver: string }>;
  refused: CleanupRefusal[];
}

const uniq = (ids: string[]) => [...new Set(ids)];

/** Pure: which of the requested rows may go. Every refusal names its reason. */
export function planCleanup(facts: CleanupFacts, sel: CleanupSelection): CleanupPlan {
  const listing = sel.caseIds === null && sel.variantIds === null && sel.graderVersionIds === null;
  const refused: CleanupRefusal[] = [];
  const refuse = (kind: CleanupKind, id: string, reason: CleanupReason, detail: Record<string, unknown> = {}) => {
    // A listing shows what can go; it does not list every row that cannot.
    if (!listing) refused.push({ kind, id, reason, detail });
  };

  const caseFacts = new Map(facts.cases.map((c) => [c.id, c]));
  const caseIds = listing ? facts.cases.map((c) => c.id) : uniq(sel.caseIds ?? []);
  const cases: CleanupPlan["cases"] = [];
  for (const id of caseIds) {
    const f = caseFacts.get(id);
    if (!f) refuse("case", id, "not_found");
    else if (f.runCount > 0) refuse("case", id, "referenced_by_runs", { runs: f.runCount });
    else cases.push({ id, caseKey: f.caseKey });
  }
  const goingCases = new Set(cases.map((c) => c.id));

  const variantFacts = new Map(facts.variants.map((v) => [v.id, v]));
  const variantIds = listing ? facts.variants.map((v) => v.id) : uniq(sel.variantIds ?? []);
  const variants: CleanupPlan["variants"] = [];
  for (const id of variantIds) {
    const f = variantFacts.get(id);
    if (!f) {
      refuse("variant", id, "not_found");
      continue;
    }
    if (f.runCount > 0) {
      refuse("variant", id, "referenced_by_runs", { runs: f.runCount });
      continue;
    }
    // A case that is deleted in this same request releases its baseline; a case that stays keeps it.
    const staying = f.baselineOfCaseIds.filter((c) => !goingCases.has(c));
    if (staying.length > 0) refuse("variant", id, "baseline_of_case", { case_ids: staying });
    else variants.push({ id, label: f.label });
  }

  const graderFacts = new Map(facts.graders.map((g) => [g.id, g]));
  const graderIds = listing ? facts.graders.map((g) => g.id) : uniq(sel.graderVersionIds ?? []);
  const graderVersions: CleanupPlan["graderVersions"] = [];
  for (const id of graderIds) {
    const f = graderFacts.get(id);
    if (!f) refuse("grader_version", id, "not_found");
    else if (f.resultCount > 0) refuse("grader_version", id, "referenced_by_grader_results", { results: f.resultCount });
    else if (f.calibrated) refuse("grader_version", id, "grader_has_calibration");
    else graderVersions.push({ id, graderId: f.graderId, semver: f.semver });
  }

  return { listing, cases, variants, graderVersions, refused };
}

export interface CleanupOutcome {
  plan: CleanupPlan;
  /** True only when the delete committed. */
  deleted: boolean;
}

/** A delete that the database refused after the plan allowed it (a run was written in between). Nothing is deleted. */
export class CleanupConflictError extends Error {}

export interface EvalCleanupStore {
  /** One transaction: read the facts of `owner`, plan, and (when !dryRun) delete the planned rows. */
  cleanup(owner: string, tenant: string, selection: CleanupSelection, options: { dryRun: boolean }): Promise<CleanupOutcome>;
}

export interface EvalCleanupRouterDeps {
  store: EvalCleanupStore;
  /** False before 0023: the route answers 503 schema_not_ready. */
  ready: () => Promise<boolean>;
  /** TMA_RESULT_TENANT (default devfellowship). */
  tenant?: string;
}

const BODY_KEYS = new Set(["dry_run", "case_ids", "variant_ids", "grader_version_ids"]);

function idList(body: Record<string, unknown>, key: string): { ok: true; ids: string[] | null } | { ok: false; error: string; message: string } {
  const v = body[key];
  if (v === undefined) return { ok: true, ids: null };
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !UUID_RE.test(x))) {
    return { ok: false, error: "invalid_id", message: `${key} must be an array of uuids` };
  }
  if (v.length > CLEANUP_MAX_IDS) return { ok: false, error: "too_many_ids", message: `${key} takes at most ${CLEANUP_MAX_IDS} ids` };
  return { ok: true, ids: (v as string[]).map((x) => x.toLowerCase()) };
}

export function createEvalCleanupRouter(deps: EvalCleanupRouterDeps): Router {
  const router = Router();
  const tenant = deps.tenant ?? resultTenantFromEnv();

  router.post("/eval-results/cleanup", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null;
      if (!body) {
        res.status(400).json({ error: "invalid_body", message: "the body must be a JSON object" });
        return;
      }
      const unknown = Object.keys(body).find((k) => !BODY_KEYS.has(k));
      if (unknown !== undefined) {
        res.status(400).json({ error: "unknown_key", path: `/${unknown}`, message: `unknown key ${unknown}` });
        return;
      }
      // Default TRUE: only the boolean false deletes.
      if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
        res.status(400).json({ error: "invalid_dry_run", message: "dry_run must be true or false" });
        return;
      }
      const dryRun = body.dry_run !== false;
      const lists = { caseIds: idList(body, "case_ids"), variantIds: idList(body, "variant_ids"), graderVersionIds: idList(body, "grader_version_ids") };
      for (const l of Object.values(lists)) {
        if (!l.ok) {
          res.status(400).json({ error: l.error, message: l.message });
          return;
        }
      }
      const selection: CleanupSelection = {
        caseIds: (lists.caseIds as { ids: string[] | null }).ids,
        variantIds: (lists.variantIds as { ids: string[] | null }).ids,
        graderVersionIds: (lists.graderVersionIds as { ids: string[] | null }).ids,
      };
      if (!dryRun && selection.caseIds === null && selection.variantIds === null && selection.graderVersionIds === null) {
        res.status(400).json({ error: "ids_required", message: "a delete names its rows: send case_ids, variant_ids or grader_version_ids (dry_run lists the candidates)" });
        return;
      }
      if (!(await deps.ready())) {
        res.status(503).json({ error: "schema_not_ready", message: `database schema is not migrated yet (needs db/migrations/${EVAL_RESULTS_MIGRATION})` });
        return;
      }
      const out = await deps.store.cleanup(req.principal!.id, tenant, selection, { dryRun });
      const p = out.plan;
      res.json({
        dry_run: dryRun,
        deleted: out.deleted,
        selected: {
          cases: p.cases.map((c) => ({ id: c.id, case_key: c.caseKey })),
          variants: p.variants.map((v) => ({ id: v.id, label: v.label })),
          grader_versions: p.graderVersions.map((g) => ({ id: g.id, grader_id: g.graderId, semver: g.semver })),
        },
        refused: p.refused,
      });
    } catch (e) {
      if (e instanceof CleanupConflictError) {
        res.status(409).json({ error: "changed_concurrently", message: "a row was referenced while the delete ran; nothing was deleted. Try again." });
        return;
      }
      next(e);
    }
  });

  return router;
}
