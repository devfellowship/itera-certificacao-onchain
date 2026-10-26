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

/** Test seam: forget the cached answer. */
export function resetSchemaFeatures(): void {
  present = false;
  checkedAt = Number.NEGATIVE_INFINITY;
}
