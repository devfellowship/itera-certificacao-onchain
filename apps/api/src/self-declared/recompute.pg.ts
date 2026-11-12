/**
 * Postgres store of POST /eval-results/recompute (plan 20261112-tma-c4-result-store-trajectory-upload, C4-T10). Needs
 * db/migrations/0024 (run_actions.step_kind). ONE transaction: the NULL rows of the scope are read FOR UPDATE SKIP
 * LOCKED (a concurrent call takes other rows), the kind comes from hostedStepKindOf, and the UPDATE repeats
 * `step_kind is null`, so it never changes a value that is set. A dry run rolls back.
 */
import { hostedStepKindOf } from "@itera/contracts";
import type { Pool } from "pg";
import type { RecomputeOutcome, RecomputeStore } from "./recompute.js";

/** The NULL step kinds of hosted runs in the scope; $1 = owner, or null for every owner. */
const SCOPE = `from public.run_actions a join public.runs r on r.id = a.run_id
  where a.step_kind is null and r.result_origin = 'hosted' and ($1::text is null or r.owner_wallet = $1)`;

export class PgRecomputeStore implements RecomputeStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async recomputeStepKinds(owner: string | null, options: { dryRun: boolean; limit: number }): Promise<RecomputeOutcome> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const rows = (await c.query<{ id: string; tool: string; target: string | null }>(
        `select a.id, a.tool, a.target ${SCOPE} order by a.id limit $2 for update of a skip locked`,
        [owner, options.limit],
      )).rows;
      const byKind: Record<string, number> = {};
      const ids: string[] = [];
      const kinds: string[] = [];
      for (const row of rows) {
        const kind = hostedStepKindOf(row.tool, row.target);
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        ids.push(row.id);
        kinds.push(kind);
      }
      let updated = 0;
      if (!options.dryRun && ids.length > 0) {
        const r = await c.query(
          `update public.run_actions a set step_kind = v.kind
             from unnest($1::bigint[], $2::text[]) as v(id, kind)
            where a.id = v.id and a.step_kind is null`,
          [ids, kinds],
        );
        updated = r.rowCount ?? 0;
      }
      const remaining = Number((await c.query<{ n: string }>(`select count(*)::text as n ${SCOPE}`, [owner])).rows[0]?.n ?? 0);
      await c.query(options.dryRun ? "rollback" : "commit");
      return { scanned: rows.length, updated, remaining, byKind };
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
