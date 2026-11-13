/**
 * db/migrations/0026_eval_routes.sql against a real Postgres (plan 20261112-tma-c8-routing-from-evals, task T1;
 * ADR-3, ADR-4, ADR-5). Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations applied, as a
 * role that may ALTER the tables (the web3 e2e guard job sets it to its own database). Never point it at a real
 * project: the test applies the migration file.
 *
 * Proves: the file has no DB function, trigger or procedure and is one transaction; it applies a second time with no
 * error and changes nothing (catalog and row count equal); the API role may select, insert and update but not delete;
 * the CHECKs refuse an approved route with n = 4, a not_yet (absolute) or worse (relative) verdict past proposed, a live
 * route without pr_url, a second live route for the same tenant, use case and target (23505), a bad use_case_key or
 * route_target, an e-mail approver, and a fallback with a model but no agent digest; and they accept n = 5 with
 * close/absolute and same/relative.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL_ = process.env.ITERA_PG_TEST_URL;
const SQL = readFileSync(new URL("../../../../db/migrations/0026_eval_routes.sql", import.meta.url), "utf8");
const H = (c: string) => c.repeat(64);

const CONSTRAINTS = [
  "eval_routes_fallback_pair_check",
  "eval_routes_verdict_rule_check",
  "eval_routes_evidence_max_check",
  "eval_routes_cited_verdict_check",
  "eval_routes_live_check",
  "eval_routes_rolled_back_check",
];

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

describe("migration 0026 file", () => {
  it("has no DB function, trigger or procedure", () => {
    expect(SQL).not.toMatch(/create\s+(or\s+replace\s+)?(function|trigger|procedure)/i);
  });
  it("runs in one transaction", () => {
    expect(SQL.match(/^begin;$/gm)?.length).toBe(1);
    expect(SQL.match(/^commit;$/gm)?.length).toBe(1);
    expect(SQL.trimEnd().endsWith("commit;")).toBe(true);
  });
  it("changes no data, and grants no DELETE to the API role", () => {
    const code = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(code).not.toMatch(/^\s*(insert|update|delete|drop)\s/im);
    expect(code).toMatch(/grant select, insert, update on public\.eval_routes to itera_api_service;/);
    expect(code).toMatch(/revoke delete on public\.eval_routes from itera_api_service;/);
    expect(code).not.toMatch(/create\s+policy/i);
    expect(code).toMatch(/alter table public\.eval_routes enable row level security;/);
  });
});

describe.skipIf(!URL_)("migration 0026 on Postgres", () => {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  // A unique tenant per run: the fixtures are found (and deleted) by it.
  const tenant = `m0026-${randomUUID().slice(0, 8)}`;

  async function snapshot() {
    const cols = await pool.query(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'eval_routes' order by 1`,
    );
    const cons = await pool.query(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.eval_routes'::regclass order by 1`,
    );
    const idx = await pool.query(`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'eval_routes' order by 1`);
    const grants = await pool.query(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'eval_routes' order by 1, 2`,
    );
    const rls = await pool.query(`select relrowsecurity from pg_class where oid = 'public.eval_routes'::regclass`);
    const n = Number((await pool.query(`select count(*)::int as n from public.eval_routes`)).rows[0].n);
    return { cols: cols.rows, cons: cons.rows, idx: idx.rows, grants: grants.rows, rls: rls.rows, n };
  }

  /** A full approved route: every ADR-5 field set, a passing verdict. `over` replaces or adds columns. */
  const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    tenant,
    use_case_key: "fix/red-ci",
    route_target: "env:TMA_ROUTE_FIX_RED_CI",
    target_value: "opencode:zai-glm-5.3",
    rollback_value: "claude-code:sonnet",
    agent_sha256: H("a"),
    harness: "opencode",
    model_id: "zai/glm-5.3",
    picked_rule: "absolute",
    verdict: "close",
    n: 5,
    evidence_run_ids: [randomUUID()],
    compare_profile_sha256: H("c"),
    policy_version: "c8.1",
    state: "approved",
    approved_by_actor: "tainan",
    approved_at: new Date().toISOString(),
    ...over,
  });
  const insert = (cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    return pool.query(
      `insert into public.eval_routes (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(cols),
    );
  };

  beforeAll(async () => {
    await pool.query(SQL);
  });

  afterAll(async () => {
    await pool.query(`delete from public.eval_routes where tenant = $1`, [tenant]);
    await pool.end();
  });

  it("applies a second time with no error and changes nothing", async () => {
    await insert(base({ use_case_key: "snap/shot" }));
    const before = await snapshot();
    expect(before.n).toBeGreaterThan(0);
    await pool.query(SQL);
    expect(await snapshot()).toEqual(before);
  });

  it("has every constraint, RLS on with no policy, no trigger, and the API role cannot DELETE", async () => {
    const { rows } = await pool.query(`select conname from pg_constraint where conname = any($1)`, [CONSTRAINTS]);
    expect(rows.map((r: { conname: string }) => r.conname).sort()).toEqual([...CONSTRAINTS].sort());
    const s = await snapshot();
    expect(s.rls[0].relrowsecurity).toBe(true);
    expect((await pool.query(`select 1 from pg_policies where schemaname = 'public' and tablename = 'eval_routes'`)).rows).toEqual([]);
    expect((await pool.query(`select tgname from pg_trigger where not tgisinternal and tgrelid = 'public.eval_routes'::regclass`)).rows).toEqual([]);
    const priv = (await pool.query(
      `select has_table_privilege('itera_api_service', 'public.eval_routes', 'SELECT') as s,
              has_table_privilege('itera_api_service', 'public.eval_routes', 'INSERT') as i,
              has_table_privilege('itera_api_service', 'public.eval_routes', 'UPDATE') as u,
              has_table_privilege('itera_api_service', 'public.eval_routes', 'DELETE') as d`,
    )).rows[0];
    expect(priv).toEqual({ s: true, i: true, u: true, d: false });
  });

  it("accepts a proposed route with no verdict, n = 5 close/absolute, same/relative, and a full fallback", async () => {
    await insert({
      tenant, use_case_key: "review/pr", route_target: "claude-md:review-pr", target_value: "sonnet",
      agent_sha256: H("b"), harness: "claude-code", model_id: "claude-sonnet-5-5",
    });
    await insert(base({ use_case_key: "fix/a" }));
    await insert(base({ use_case_key: "fix/b", picked_rule: "relative", verdict: "same" }));
    await insert(base({ use_case_key: "fix/c", picked_rule: "relative", verdict: "better", fallback_agent_sha256: H("d"), fallback_model_id: "anthropic/claude-opus-5-5", fallback_harness: "claude-code" }));
    // A not_yet or worse verdict may stay proposed.
    await insert(base({ use_case_key: "fix/d", state: "proposed", verdict: "not_yet", n: 2 }));
  });

  it("refuses past proposed: n = 4, not_yet/absolute, worse/relative, no evidence, no approver", async () => {
    const bad: Record<string, unknown>[] = [
      { n: 4 },
      { verdict: "not_yet" },
      { picked_rule: "relative", verdict: "worse" },
      { evidence_run_ids: [] },
      { approved_by_actor: null },
      { approved_at: null },
      { compare_profile_sha256: null },
      { policy_version: null },
      { state: "needs_check", n: 4 },
    ];
    for (const over of bad) await expect(insert(base(over)).catch(pgCode), JSON.stringify(over)).resolves.toBe("23514");
  });

  it("ties the verdict set to the rule", async () => {
    for (const over of [{ picked_rule: "absolute", verdict: "better" }, { picked_rule: "relative", verdict: "close" }, { picked_rule: null }, { verdict: null }]) {
      await expect(insert(base({ ...over, state: "proposed" })).catch(pgCode), JSON.stringify(over)).resolves.toBe("23514");
    }
  });

  it("live needs pr_url and live_at; rolled_back needs rollback_pr_url and rolled_back_at", async () => {
    const now = new Date().toISOString();
    await expect(insert(base({ use_case_key: "live/x", state: "live", live_at: now })).catch(pgCode)).resolves.toBe("23514");
    await expect(insert(base({ use_case_key: "live/x", state: "live", pr_url: "https://github.com/devfellowship/dfl-harness/pull/1" })).catch(pgCode)).resolves.toBe("23514");
    await expect(insert(base({ use_case_key: "rb/x", state: "rolled_back", rolled_back_at: now })).catch(pgCode)).resolves.toBe("23514");
    await insert(base({ use_case_key: "rb/x", state: "rolled_back", rollback_pr_url: "https://github.com/devfellowship/dfl-harness/pull/2", rolled_back_at: now }));
    await expect(insert(base({ use_case_key: "live/x", state: "live", pr_url: "https://evil.example/pull/1", live_at: now })).catch(pgCode)).resolves.toBe("23514");
  });

  it("refuses a second live row for the same tenant, use case and target (23505), but not for another target", async () => {
    const now = new Date().toISOString();
    const live = { use_case_key: "live/one", state: "live", pr_url: "https://github.com/devfellowship/dfl-harness/pull/3", live_at: now };
    await insert(base(live));
    await expect(insert(base(live)).catch(pgCode)).resolves.toBe("23505");
    await insert(base({ ...live, route_target: "claude-md:live-one" }));
    // Many non-live rows for the same key are history and are allowed.
    await insert(base({ use_case_key: "live/one" }));
    await insert(base({ use_case_key: "live/one" }));
  });

  it("refuses a bad use_case_key, route_target or values, an e-mail approver and a half fallback", async () => {
    const bad: Record<string, unknown>[] = [
      { use_case_key: "code" },
      { use_case_key: "Code/Review" },
      { use_case_key: "code/review/deep" },
      { route_target: "env:lower_case" },
      { route_target: "ENV:TMA_X" },
      { route_target: "claude-md:Row" },
      { route_target: "file:/etc/passwd" },
      { target_value: "Has Space" },
      { rollback_value: "UPPER" },
      { approved_by_actor: "tainan@example.com" },
      { fallback_model_id: "zai/glm-5.3" },
      { fallback_agent_sha256: H("e") },
      { agent_sha256: "A".repeat(64) },
      { harness_repo_sha: H("f").slice(0, 39) },
      { n: -1, state: "proposed" },
      { policy_version: "V1" },
      { evidence_run_ids: Array.from({ length: 501 }, () => randomUUID()) },
    ];
    for (const over of bad) {
      const label = JSON.stringify(over).slice(0, 120);
      await expect(insert(base(over)).catch(pgCode), label).resolves.toBe("23514");
    }
  });
});
