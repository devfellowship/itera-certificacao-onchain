/**
 * Optional schema features: code that must keep working BEFORE a migration is applied on production
 * (a merge to main deploys the API; TMA applies its migrations by hand, later).
 *
 * 0021_self_declared_results.sql adds `result_origin` to evaluations and runs. Until it is applied,
 * no self-declared row can exist, so a read needs no origin filter. After it is applied, every read
 * that is public or aggregate keeps ONLY hosted rows (plan 20261026-tma-local-runner-and-self-
 * declared-results, Q4 = C: a self-declared result is visible only to its owner).
 *
 * The probe caches `true` for the life of the process (a migration is never rolled back) and
 * re-asks at most once a minute while the answer is `false`.
 */
type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

const RECHECK_MS = 60_000;
let present = false;
let checkedAt = Number.NEGATIVE_INFINITY;

export async function hasSelfDeclaredSchema(db: Queryable, now: number = Date.now()): Promise<boolean> {
  if (present) return true;
  if (now - checkedAt < RECHECK_MS) return false;
  checkedAt = now;
  try {
    const { rows } = await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'runs' and column_name = 'result_origin'`,
    );
    present = rows.length > 0;
  } catch {
    present = false;
  }
  return present;
}

/** SQL fragment ` and <alias>.result_origin = 'hosted'`, or "" before 0021. */
export function hostedOnly(selfDeclaredSchema: boolean, alias: string): string {
  return selfDeclaredSchema ? ` and ${alias}.result_origin = 'hosted'` : "";
}

/**
 * 0023_eval_results.sql (plan 20261112-tma-c4-result-store-trajectory-upload, T2, T8) adds eval_cases,
 * eval_variants, grader_versions, grader_results and the case / trajectory columns. Until it is applied on
 * production, a tma-local-result/2 upload answers 503 schema_not_ready (nothing is written) and the read
 * routes add no case, variant, grader or trajectory field. v1 uploads and every other route are unchanged.
 * Same cache rule as the 0021 probe: `true` for the life of the process, `false` re-asked once a minute.
 */
let evalPresent = false;
let evalCheckedAt = Number.NEGATIVE_INFINITY;

export async function hasEvalResultsSchema(db: Queryable, now: number = Date.now()): Promise<boolean> {
  if (evalPresent) return true;
  if (now - evalCheckedAt < RECHECK_MS) return false;
  evalCheckedAt = now;
  try {
    // The last object of 0023 (the file is one transaction, so this column means the whole file is applied),
    // and a column that only the T8 shape has (a test case with its baseline variant; the agent variant is
    // independent of the case). The first 0023 shape answers false: this API cannot write to it.
    const { rows } = await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'run_actions' and column_name = 'retry_of')
            or (table_name = 'eval_cases' and column_name = 'baseline_variant_id'))`,
    );
    evalPresent = rows.length === 2;
  } catch {
    evalPresent = false;
  }
  return evalPresent;
}

/**
 * 0025_grader_versions_created_by.sql adds grader_versions.created_by. Until it is applied, a v2 upload registers
 * a grader version with no creator (the insert names no created_by). Same cache rule as the probes above.
 */
let graderCreatedByPresent = false;
let graderCreatedByCheckedAt = Number.NEGATIVE_INFINITY;

export async function hasGraderCreatedBy(db: Queryable, now: number = Date.now()): Promise<boolean> {
  if (graderCreatedByPresent) return true;
  if (now - graderCreatedByCheckedAt < RECHECK_MS) return false;
  graderCreatedByCheckedAt = now;
  try {
    const { rows } = await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'grader_versions' and column_name = 'created_by'`,
    );
    graderCreatedByPresent = rows.length > 0;
  } catch {
    graderCreatedByPresent = false;
  }
  return graderCreatedByPresent;
}

/**
 * 0024_eval_summary_steps_grader_meta.sql (plan 20261112-tma-c4-result-store-trajectory-upload, T9-T11) adds
 * eval_cases.task_summary, the tma-trajectory/2 step columns of run_actions, the proof, calibration, note and author
 * of grader_versions and the reason code and labeler of grader_results. Until it is applied, a v2 upload that uses
 * one of those fields answers 503 schema_not_ready (nothing is written), every other v2 upload is written as before,
 * and the read routes add none of those fields. Same cache rule as the probes above.
 */
let metaPresent = false;
let metaCheckedAt = Number.NEGATIVE_INFINITY;

export async function hasEvalMetaSchema(db: Queryable, now: number = Date.now()): Promise<boolean> {
  if (metaPresent) return true;
  if (now - metaCheckedAt < RECHECK_MS) return false;
  metaCheckedAt = now;
  try {
    // The first and the last column of 0024 (the file is one transaction).
    const { rows } = await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'eval_cases' and column_name = 'task_summary')
            or (table_name = 'grader_results' and column_name = 'labeler'))`,
    );
    metaPresent = rows.length === 2;
  } catch {
    metaPresent = false;
  }
  return metaPresent;
}

/**
 * 0026_eval_routes.sql (plan 20261112-tma-c8-routing-from-evals, T1) adds eval_routes. Until it is applied, the route
 * endpoints (T2) answer 503 schema_not_ready. Same cache rule as the probes above.
 */
let routesPresent = false;
let routesCheckedAt = Number.NEGATIVE_INFINITY;

export async function hasEvalRoutesSchema(db: Queryable, now: number = Date.now()): Promise<boolean> {
  if (routesPresent) return true;
  if (now - routesCheckedAt < RECHECK_MS) return false;
  routesCheckedAt = now;
  try {
    // The last column of the table (the file is one transaction) and the one-live index.
    const { rows } = await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'eval_routes' and column_name = 'updated_at'
       union all
       select 1 from pg_indexes where schemaname = 'public' and indexname = 'eval_routes_one_live_idx'`,
    );
    routesPresent = rows.length === 2;
  } catch {
    routesPresent = false;
  }
  return routesPresent;
}

/** Test seam: forget the cached answers. */
export function resetSchemaFeatures(): void {
  present = false;
  checkedAt = Number.NEGATIVE_INFINITY;
  evalPresent = false;
  evalCheckedAt = Number.NEGATIVE_INFINITY;
  graderCreatedByPresent = false;
  graderCreatedByCheckedAt = Number.NEGATIVE_INFINITY;
  metaPresent = false;
  metaCheckedAt = Number.NEGATIVE_INFINITY;
  routesPresent = false;
  routesCheckedAt = Number.NEGATIVE_INFINITY;
}
