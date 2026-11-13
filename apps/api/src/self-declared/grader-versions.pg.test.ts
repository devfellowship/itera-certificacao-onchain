/**
 * PgGraderVersionsReader on a real Postgres (plan 20261112-tma-c5-studio-area-web2, C5-T5). Runs when ITERA_PG_TEST_URL
 * points at a THROWAWAY Postgres with db/migrations applied up to 0024. Inserts grader_versions rows directly under two
 * random tenants and proves the list and detail are tenant scoped, with usedByCount 0 for an unused version.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { PgGraderVersionsReader } from "./grader-versions.js";

const URL_ = process.env.ITERA_PG_TEST_URL;

describe.skipIf(!URL_)("PgGraderVersionsReader on Postgres", () => {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const reader = new PgGraderVersionsReader(() => pool);
  const t1 = `gv-${randomUUID().slice(0, 8)}`;
  const t2 = `gv-${randomUUID().slice(0, 8)}`;
  let id1 = "";

  beforeAll(async () => {
    resetSchemaFeatures();
    id1 = (await pool.query(`insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256) values ($1, 'hidden-tests', '1.0.0', 'code', $2) returning id`, [t1, "a".repeat(64)])).rows[0].id;
    await pool.query(`insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256) values ($1, 'other', '1.0.0', 'code', $2)`, [t2, "b".repeat(64)]);
  });
  afterAll(async () => {
    await pool.query(`delete from public.grader_versions where tenant = any($1)`, [[t1, t2]]);
    await pool.end();
  });

  it("lists only the tenant's versions and reads a detail", async () => {
    const list = await reader.list(t1);
    expect(list.map((g) => g.graderId)).toEqual(["hidden-tests"]);
    expect(list[0]).toMatchObject({ semver: "1.0.0", kind: "code", usedByCount: 0 });
    expect(await reader.detail(id1, t1)).toMatchObject({ id: id1, recentRuns: [] });
  });

  it("answers null for another tenant", async () => {
    expect(await reader.detail(id1, t2)).toBeNull();
  });
});
