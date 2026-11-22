/**
 * Postgres store of POST /eval-results/run-cost (plan 20261112-tma-c7-model-comparison-per-use-case, C7-COST). ONE
 * transaction: the runs of the caller's self-declared evaluation are read FOR UPDATE, planRunCost matches the entries,
 * and the UPDATE writes ONLY model_cost_usd and model_cost_source. Its WHERE repeats the owner, the origin, the stored
 * tokens and `model_cost_usd is null`, so it never changes a run that has a cost. A dry run rolls back.
 */
import type { RunCostBody } from "@itera/contracts";
import type { Pool } from "pg";
import { planRunCost, type RunCostOutcome, type RunCostStore, type StoredCostRun } from "./run-cost.js";
import { SelfDeclaredError } from "./store.js";

export class PgRunCostStore implements RunCostStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async applyRunCost(owner: string, body: RunCostBody, options: { dryRun: boolean }): Promise<RunCostOutcome> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const ev = (await c.query<{ owner_wallet: string; result_origin: string }>(
        `select owner_wallet, result_origin from public.evaluations where id = $1`,
        [body.evaluation_id],
      )).rows[0];
      if (!ev || ev.owner_wallet !== owner || ev.result_origin !== "self_declared") {
        throw new SelfDeclaredError(404, "evaluation_not_found", "no self-declared evaluation of yours has this id");
      }
      const stored = (await c.query<{ id: string; tokens_in: number | null; tokens_out: number | null; cost: string | null; source: string | null; model: string | null }>(
        `select id, model_tokens_in as tokens_in, model_tokens_out as tokens_out, model_cost_usd as cost, model_cost_source as source,
                model_requested as model
           from public.runs
          where evaluation_id = $1 and owner_wallet = $2 and result_origin = 'self_declared'
          order by seq for update`,
        [body.evaluation_id, owner],
      )).rows.map((r): StoredCostRun => ({
        id: r.id,
        tokensIn: r.tokens_in === null ? null : Number(r.tokens_in),
        tokensOut: r.tokens_out === null ? null : Number(r.tokens_out),
        costUsd: r.cost === null ? null : Number(r.cost),
        costSource: r.source,
        model: r.model,
      }));
      const plan = planRunCost(stored, body);
      let updated = 0;
      if (!options.dryRun) {
        for (const p of plan) {
          if (p.op !== "update") continue;
          const r = await c.query(
            `update public.runs set model_cost_usd = $2, model_cost_source = $4
              where id = $1 and owner_wallet = $3 and result_origin = 'self_declared' and model_cost_usd is null`,
            [p.runId, p.costUsd, owner, body.cost_source ?? "derived"],
          );
          updated += r.rowCount ?? 0;
        }
      }
      const out: RunCostOutcome = {
        evaluationId: body.evaluation_id,
        matched: plan.length,
        updated: options.dryRun ? plan.filter((p) => p.op === "update").length : updated,
        unchanged: plan.filter((p) => p.op === "same").length,
        runs: plan.map((p) => ({ runId: p.runId, costUsd: p.costUsd })),
      };
      await c.query(options.dryRun ? "rollback" : "commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
