/**
 * POST /eval-results/run-cost — add a DERIVED cost to runs that are already stored (plan
 * 20261112-tma-c7-model-comparison-per-use-case, task C7-COST). A producer that wrote a patch outside the kit (Claude
 * Code, Codex, opencode) uploaded its tokens and no cost, so the compare route reads `cost_label: null`. This route
 * prices the measured tokens at a dated list price. It is a data repair on the caller's own rows (CLAUDE.md "DDL vs
 * DML": a route on the caller's identity, never a migration).
 *
 *   auth      a TMA session of a `dfl` principal (any other → 403 self_declared_dfl_only).
 *   body      tma-run-cost/1 (@itera/contracts validateRunCost): { format, evaluation_id, dry_run?, cost_source? ('derived' | 'estimate', default derived), price {model_id, input,
 *             cache_read, cache_write, output (USD per 1M tokens), source_url, as_of, table_sha256}, runs [{tokens_in,
 *             tokens_out, cache_read_tokens, cache_write_tokens}] }. Closed: an unknown key is 400 unknown_key.
 *             dry_run defaults to TRUE; only the boolean false writes.
 *   match     each entry is matched to ONE stored run of that evaluation by its stored token counts (model_tokens_in =
 *             tokens_in, model_tokens_out = tokens_out). The run must be the caller's, self-declared, and its stored model
 *             must be price.model_id. An entry that matches no run, or more entries than runs, is 409 run_not_found.
 *   writes    ONLY runs.model_cost_usd and runs.model_cost_source (= body.cost_source: 'derived' by default, or 'estimate'), and only on a run whose cost is null. A run
 *             that already has the same cost with the same source is `unchanged`; a run that has another cost is 409 cost_exists
 *             (a metered or earlier cost is never overwritten; an estimate never replaces a derived cost, nor the reverse). It never touches a grade (grader_results has no UPDATE
 *             grant for the API role), the evidence manifest, the import digest, the patch digest, the score, the
 *             tokens, the provenance or any other column. All or nothing, in one transaction.
 *   cost      the server recomputes it with derivedCostUsd from the price and the tokens of the body; the body carries
 *             no cost number.
 *   answer    200 { format, evaluation_id, dry_run, cost_source, matched, updated, unchanged, runs: [{run_id, cost_usd}] }.
 *   not ready 503 schema_not_ready before db/migrations/0023 (the self-declared v2 rows do not exist).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { RUN_COST_FORMAT, derivedCostUsd, validateRunCost, type RunCostBody } from "@itera/contracts";
import { requirePrincipal } from "../auth/middleware.js";
import { EVAL_RESULTS_MIGRATION, SelfDeclaredError } from "./store.js";

export interface RunCostOutcome {
  evaluationId: string;
  matched: number;
  updated: number;
  unchanged: number;
  runs: Array<{ runId: string; costUsd: number }>;
}

export interface RunCostStore {
  /** One transaction; `owner` is the caller. dryRun rolls back. Throws SelfDeclaredError (404 / 409) before any write commits. */
  applyRunCost(owner: string, body: RunCostBody, options: { dryRun: boolean }): Promise<RunCostOutcome>;
}

export interface RunCostRouterDeps {
  store: RunCostStore;
  /** False before 0023: the route answers 503 schema_not_ready. */
  ready: () => Promise<boolean>;
}

/** The stored row of a run, as the matching rule needs it. */
export interface StoredCostRun {
  id: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  costSource: string | null;
  model: string | null;
}

export interface CostPlanEntry {
  runId: string;
  costUsd: number;
  op: "update" | "same";
}

/**
 * The matching rule, pure: each entry takes one stored run with the same token counts and the price model. The same
 * tokens twice need two runs. A cost that already exists is `same` when it is this derived cost, else 409 cost_exists.
 */
export function planRunCost(stored: StoredCostRun[], body: RunCostBody): CostPlanEntry[] {
  const source = body.cost_source ?? "derived";
  const free = stored.filter((s) => s.model === body.price.model_id);
  const used = new Set<string>();
  return body.runs.map((entry, i) => {
    const costUsd = derivedCostUsd(body.price, {
      tokensIn: entry.tokens_in,
      tokensOut: entry.tokens_out,
      cacheRead: entry.cache_read_tokens,
      cacheWrite: entry.cache_write_tokens,
    });
    if (costUsd === null) throw new SelfDeclaredError(409, "invalid_cost", `runs[${i}] has no computable cost`);
    // Prefer a run that still has no cost, so two entries with equal tokens fill two runs.
    const candidates = free.filter((s) => !used.has(s.id) && s.tokensIn === entry.tokens_in && s.tokensOut === entry.tokens_out);
    const hit = candidates.find((s) => s.costUsd === null) ?? candidates[0];
    if (!hit) {
      throw new SelfDeclaredError(409, "run_not_found", `runs[${i}] matches no run of this evaluation by its tokens (${entry.tokens_in} in, ${entry.tokens_out} out) and the model ${body.price.model_id}`);
    }
    used.add(hit.id);
    if (hit.costUsd === null) return { runId: hit.id, costUsd, op: "update" as const };
    if (hit.costSource === source && Math.abs(hit.costUsd - costUsd) < 5e-7) return { runId: hit.id, costUsd, op: "same" as const };
    throw new SelfDeclaredError(409, "cost_exists", `runs[${i}] already has a cost (${hit.costUsd}, ${hit.costSource ?? "no source"}); it is never overwritten`);
  });
}

export function createRunCostRouter(deps: RunCostRouterDeps): Router {
  const router = Router();

  router.post("/eval-results/run-cost", requirePrincipal, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.principal?.kind !== "dfl") {
        res.status(403).json({ error: "self_declared_dfl_only", message: "self-declared results take a Login with DFL session" });
        return;
      }
      const checked = validateRunCost(req.body);
      if (!checked.ok) {
        const h = checked.issues.find((i) => i.code === "unknown_key") ?? checked.issues[0]!;
        res.status(400).json({ error: h.code, path: h.path, message: h.message, issues: checked.issues.slice(0, 20) });
        return;
      }
      const dryRun = checked.value.dry_run !== false;
      if (!(await deps.ready())) {
        res.status(503).json({ error: "schema_not_ready", message: `database schema is not migrated yet (needs db/migrations/${EVAL_RESULTS_MIGRATION})` });
        return;
      }
      const out = await deps.store.applyRunCost(req.principal.id, checked.value, { dryRun });
      res.json({
        format: RUN_COST_FORMAT,
        evaluation_id: out.evaluationId,
        dry_run: dryRun,
        cost_source: checked.value.cost_source ?? "derived",
        matched: out.matched,
        updated: dryRun ? 0 : out.updated,
        unchanged: out.unchanged,
        runs: out.runs.map((r) => ({ run_id: r.runId, cost_usd: r.costUsd })),
      });
    } catch (e) {
      if (e instanceof SelfDeclaredError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      next(e);
    }
  });

  return router;
}
