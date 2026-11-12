/**
 * db/migrations/0025_grader_versions_created_by.sql against a real Postgres (plan 20261112-tma-c4-result-store-
 * trajectory-upload, task C4-T13 follow-up). Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with
 * db/migrations applied, as a role that may ALTER the tables (the web3 e2e guard job sets it). Never point it at a
 * real project: the test applies the migration file.
 *
 * Proves: the file is one transaction with no DB function or trigger; it applies a second time with no error and
 * changes nothing; grader_versions.created_by is a nullable uuid with no default, and a row inserted without it keeps
 * NULL (an upload from before the column, or from the hosted runner).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const URL_ = process.env.ITERA_PG_TEST_URL;
const SQL = readFileSync(new URL("../../../../db/migrations/0025_grader_versions_created_by.sql", import.meta.url), "utf8");

describe("migration 0025 file", () => {
  it("has no DB function, trigger or procedure", () => {
    expect(SQL).not.toMatch(/create\s+(or\s+replace\s+)?(function|trigger|procedure)/i);
  });
  it("runs in one transaction", () => {
    expect(SQL.match(/^begin;$/gm)?.length).toBe(1);
    expect(SQL.trimEnd().endsWith("commit;")).toBe(true);
  });
  it("adds only the one nullable column: no default, no backfill, no drop", () => {
    expect(SQL).toMatch(/add column if not exists created_by uuid;/);
    const code = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(drop|update|insert|delete)\b\s/i);
    expect(code).not.toMatch(/created_by uuid[^;]*(default|not null)/i);
  });
});

describe.skipIf(!URL_)("migration 0025 on Postgres", () => {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const tag = `m0025-${randomUUID().slice(0, 8)}`;
  const tenant = "devfellowship";

  const snapshot = async () => ({
    cols: (await pool.query(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'grader_versions' order by column_name`,
    )).rows,
    n: Number((await pool.query(`select count(*) as n from public.grader_versions`)).rows[0].n),
  });

  afterAll(async () => {
    await pool.query(`delete from public.grader_versions where grader_id = $1`, [tag]);
    await pool.end();
  });

  it("applies a second time with no error and changes nothing", async () => {
    const before = await snapshot();
    await pool.query(SQL);
    expect(await snapshot()).toEqual(before);
  });

  it("created_by is a nullable uuid with no default", async () => {
    const col = (await snapshot()).cols.find((c: { column_name: string }) => c.column_name === "created_by");
    expect(col).toMatchObject({ data_type: "uuid", is_nullable: "YES", column_default: null });
  });

  it("a row inserted without created_by keeps NULL, and a row can carry a creator", async () => {
    const plain = (await pool.query(
      `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256) values ($1, $2, '1.0.0', 'code', $3) returning created_by`,
      [tenant, tag, "a".repeat(64)],
    )).rows[0];
    expect(plain.created_by).toBeNull();
    const user = randomUUID();
    const owned = (await pool.query(
      `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256, created_by) values ($1, $2, '1.0.0', 'code', $3, $4) returning created_by`,
      [tenant, tag, "b".repeat(64), user],
    )).rows[0];
    expect(owned.created_by).toBe(user);
  });
});
