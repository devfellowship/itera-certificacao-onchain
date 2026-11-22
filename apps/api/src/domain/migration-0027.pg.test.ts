/**
 * db/migrations/0027_run_cost_source_estimate.sql against a real Postgres (plan 20261112-tma-c7-model-comparison-per-
 * use-case, task C7-COST-LABEL). Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations
 * applied, as a role that may ALTER the tables (the web3 e2e guard job sets it). Never point it at a real project: the
 * test applies the migration file.
 *
 * Proves: the file is one transaction with no DB function, trigger or data change; it applies a second time with no
 * error and changes nothing; public.runs has exactly ONE check on model_cost_source; that check accepts the six known
 * values (estimate included) and NULL, and refuses any other value.
 */
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const URL_ = process.env.ITERA_PG_TEST_URL;
const SQL = readFileSync(new URL("../../../../db/migrations/0027_run_cost_source_estimate.sql", import.meta.url), "utf8");

describe("migration 0027 file", () => {
  it("has no DB function, trigger or procedure", () => {
    expect(SQL).not.toMatch(/create\s+(or\s+replace\s+)?(function|trigger|procedure)/i);
  });
  it("runs in one transaction", () => {
    expect(SQL.match(/^begin;$/gm)?.length).toBe(1);
    expect(SQL.trimEnd().endsWith("commit;")).toBe(true);
  });
  it("changes no data and no grant", () => {
    const code = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(update|insert|delete|truncate|grant|revoke)\b\s/i);
  });
});

describe.skipIf(!URL_)("migration 0027 on Postgres", () => {
  const pool = new Pool({ connectionString: URL_, max: 2 });

  const checks = async () =>
    (await pool.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.runs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%model_cost_source%'
        order by conname`,
    )).rows;

  afterAll(async () => {
    await pool.end();
  });

  it("applies a second time with no error and changes nothing", async () => {
    const before = await checks();
    await pool.query(SQL);
    expect(await checks()).toEqual(before);
  });

  it("leaves exactly one named check on model_cost_source", async () => {
    const rows = await checks();
    expect(rows.map((r) => r.conname)).toEqual(["runs_model_cost_source_check"]);
  });

  it("the check accepts NULL and the six known values, and refuses any other value", async () => {
    const def = (await checks())[0]!.def;
    // Evaluate the LIVE check expression on a scratch table: no runs fixture is needed and no real row changes.
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("create temp table m0027_probe (model_cost_source text) on commit drop");
      await c.query(`alter table m0027_probe add constraint m0027_probe_check ${def}`);
      for (const v of [null, "metered", "derived", "mixed", "unpriced", "none", "estimate"]) {
        await c.query("insert into m0027_probe values ($1)", [v]);
      }
      await c.query("savepoint bad");
      await expect(c.query("insert into m0027_probe values ('guess')")).rejects.toMatchObject({ code: "23514" });
      await c.query("rollback to savepoint bad");
      await expect(c.query("insert into m0027_probe values ('Estimate')")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });
});
