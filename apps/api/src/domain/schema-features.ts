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

/** Test seam: forget the cached answers. */
export function resetSchemaFeatures(): void {
  present = false;
  checkedAt = Number.NEGATIVE_INFINITY;
  evalPresent = false;
  evalCheckedAt = Number.NEGATIVE_INFINITY;
}
