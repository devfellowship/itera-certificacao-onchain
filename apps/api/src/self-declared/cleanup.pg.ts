/**
 * Postgres store of POST /eval-results/cleanup (plan 20261112-tma-c4-result-store-trajectory-upload, C4-T13).
 * Needs db/migrations/0023_eval_results.sql. ONE transaction: the candidate rows are read FOR UPDATE (an upload
 * that writes a run for one of them takes a FOR KEY SHARE lock on it through the foreign key, so it waits for
 * this transaction or this one waits for it), the pure plan decides, and the DELETEs repeat the same guards in SQL
 * and must remove exactly the planned rows. A foreign-key refusal (23503) rolls everything back as a conflict.
 */
import type { Pool, PoolClient } from "pg";
import {
  CleanupConflictError,
  planCleanup,
  type CleanupFacts,
  type CleanupOutcome,
  type CleanupSelection,
  type EvalCleanupStore,
} from "./cleanup.js";

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

/** SQL `uuid[]` parameter: the ids, or null for "every row" (a listing). */
const param = (ids: string[] | null, listing: boolean): string[] | null => (listing ? null : (ids ?? []));

export class PgEvalCleanupStore implements EvalCleanupStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async cleanup(owner: string, tenant: string, sel: CleanupSelection, options: { dryRun: boolean; graderAdmin: boolean }): Promise<CleanupOutcome> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const facts = await this.facts(c, owner, tenant, sel, options.graderAdmin);
      const plan = planCleanup(facts, sel, { graderAdmin: options.graderAdmin });
      if (options.dryRun || (!plan.cases.length && !plan.variants.length && !plan.graderVersions.length)) {
        await c.query("rollback");
        return { plan, deleted: false };
      }
      await this.apply(c, owner, tenant, plan, options.graderAdmin);
      await c.query("commit");
      return { plan, deleted: true };
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      if (pgCode(e) === "23503") throw new CleanupConflictError("foreign key refused the delete");
      throw e;
    } finally {
      c.release();
    }
  }

  private async facts(c: PoolClient, owner: string, tenant: string, sel: CleanupSelection, graderAdmin: boolean): Promise<CleanupFacts> {
    const listing = sel.caseIds === null && sel.variantIds === null && sel.graderVersionIds === null;
    const cases = await c.query(
      `select k.id, k.case_key, (select count(*)::int from public.runs r where r.case_id = k.id) as run_count
         from public.eval_cases k
        where k.owner_wallet = $1 and k.tenant = $2 and ($3::uuid[] is null or k.id = any($3::uuid[]))
        order by k.created_at, k.id
          for update of k`,
      [owner, tenant, param(sel.caseIds, listing)],
    );
    const variants = await c.query(
      `select v.id, v.label, (select count(*)::int from public.runs r where r.variant_id = v.id) as run_count,
              array(select k.id from public.eval_cases k where k.baseline_variant_id = v.id order by k.id) as baseline_of
         from public.eval_variants v
        where v.owner_wallet = $1 and v.tenant = $2 and ($3::uuid[] is null or v.id = any($3::uuid[]))
        order by v.created_at, v.id
          for update of v`,
      [owner, tenant, param(sel.variantIds, listing)],
    );
    // The grader registry is read (and locked) only for an admin: for anyone else it is not even looked at.
    const graders = !graderAdmin ? { rows: [] as Array<Record<string, unknown>> } : await c.query(
      `select g.id, g.grader_id, g.semver, (select count(*)::int from public.grader_results x where x.grader_version_id = g.id) as result_count,
              (g.judge_model_id is not null or g.rubric_sha256 is not null or g.params_sha256 is not null
               or g.tpr is not null or g.tnr is not null or g.test_split_sha256 is not null) as calibrated
         from public.grader_versions g
        where g.tenant = $1 and ($2::uuid[] is null or g.id = any($2::uuid[]))
        order by g.created_at, g.id
          for update of g`,
      [tenant, param(sel.graderVersionIds, listing)],
    );
    return {
      cases: cases.rows.map((r) => ({ id: r.id, caseKey: r.case_key, runCount: Number(r.run_count) })),
      variants: variants.rows.map((r) => ({ id: r.id, label: r.label, runCount: Number(r.run_count), baselineOfCaseIds: r.baseline_of as string[] })),
      graders: graders.rows.map((r) => ({ id: String(r.id), graderId: String(r.grader_id), semver: String(r.semver), resultCount: Number(r.result_count), calibrated: Boolean(r.calibrated) })),
    };
  }

  /** Cases first (they release their baseline), then variants, then grader versions. Each DELETE must remove exactly the planned rows. */
  private async apply(c: PoolClient, owner: string, tenant: string, plan: ReturnType<typeof planCleanup>, graderAdmin: boolean): Promise<void> {
    // Second check: a plan with a grader version for a caller that is not an admin never reaches the DELETE.
    if (plan.graderVersions.length && !graderAdmin) throw new CleanupConflictError("grader versions: the caller is not an admin");
    const expect = async (what: string, sql: string, params: unknown[], want: number) => {
      const r = await c.query(sql, params);
      if ((r.rowCount ?? 0) !== want) throw new CleanupConflictError(`${what}: deleted ${r.rowCount ?? 0} of ${want} planned rows`);
    };
    if (plan.cases.length) {
      await expect(
        "cases",
        `delete from public.eval_cases k
          where k.id = any($1::uuid[]) and k.owner_wallet = $2 and k.tenant = $3
            and not exists (select 1 from public.runs r where r.case_id = k.id)`,
        [plan.cases.map((x) => x.id), owner, tenant],
        plan.cases.length,
      );
    }
    if (plan.variants.length) {
      await expect(
        "variants",
        `delete from public.eval_variants v
          where v.id = any($1::uuid[]) and v.owner_wallet = $2 and v.tenant = $3
            and not exists (select 1 from public.runs r where r.variant_id = v.id)
            and not exists (select 1 from public.eval_cases k where k.baseline_variant_id = v.id)`,
        [plan.variants.map((x) => x.id), owner, tenant],
        plan.variants.length,
      );
    }
    if (plan.graderVersions.length) {
      await expect(
        "grader versions",
        `delete from public.grader_versions g
          where g.id = any($1::uuid[]) and g.tenant = $2
            and g.judge_model_id is null and g.rubric_sha256 is null and g.params_sha256 is null
            and g.tpr is null and g.tnr is null and g.test_split_sha256 is null
            and not exists (select 1 from public.grader_results x where x.grader_version_id = g.id)`,
        [plan.graderVersions.map((x) => x.id), tenant],
        plan.graderVersions.length,
      );
    }
  }
}
