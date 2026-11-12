/**
 * db/migrations/0023_eval_results.sql against a real Postgres (plan 20261112-tma-c4-result-store-trajectory-
 * upload, task T2). Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations applied, as a
 * role that may ALTER the tables (the web3 e2e guard job sets it to its own database). Never point it at a real
 * project: the test applies the migration file.
 *
 * Proves: the file applies a second time with no error and changes nothing (the catalog of the new tables and
 * columns and the row counts are equal before and after); it has no DB function or trigger; the CHECKs and keys
 * refuse the forbidden shapes (a second baseline, a baseline with a change or a prediction, a replay case with
 * no pin, a variant in another tenant, a run with a case and no variant, a run whose variant is of another
 * case, judge fields on a code grader, an ok step with an error class, a step whose parent is not earlier);
 * the API role cannot UPDATE grader_results (a re-grade adds a row), and a run's grader rows go with the run.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL_ = process.env.ITERA_PG_TEST_URL;
const SQL = readFileSync(new URL("../../../../db/migrations/0023_eval_results.sql", import.meta.url), "utf8");
const H = (c: string) => c.repeat(64);

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

describe("migration 0023 file", () => {
  it("has no DB function, trigger or procedure", () => {
    expect(SQL).not.toMatch(/create\s+(or\s+replace\s+)?(function|trigger|procedure)/i);
  });
  it("runs in one transaction", () => {
    expect(SQL.match(/^begin;$/gm)?.length).toBe(1);
    expect(SQL.trimEnd().endsWith("commit;")).toBe(true);
  });
});

describe.skipIf(!URL_)("migration 0023 on Postgres", () => {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const tag = `m0023-${randomUUID().slice(0, 8)}`;
  const owner = `dfl:${randomUUID()}`;
  const tenant = "devfellowship";
  let agentId = "";
  let versionId = "";
  let releaseId = "";
  let caseId = "";
  let otherCaseId = "";
  let baselineId = "";
  let variantId = "";
  let otherVariantId = "";
  let graderId = "";
  const runIds: string[] = [];

  async function newRun(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into public.evaluations (id, slug, short_id, owner_wallet, agent_id, agent_version_id, model_id, tasks, status, task_count, payment_kind, score, is_public)
       values ($1, $2, $3, $4, $5, $6, 'zai/glm-5.3', '[]'::jsonb, 'review', 1, 'free_byok', 50, false)`,
      [id, `${tag}-${id.slice(0, 8)}`, `S${id.replaceAll("-", "").slice(0, 20)}`, owner, agentId, versionId],
    );
    await pool.query(
      `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, evidence_manifest, score_total,
         agent_version_id, owner_wallet, evaluation_id, seq)
       values ($1, $2, $3, '1', $4, 'pass', '{}'::jsonb, 50, $5, $6, $1, 1)`,
      [id, releaseId, tag, `${tag}-${id}`, versionId, owner],
    );
    runIds.push(id);
    return id;
  }

  async function newCase(key: string, mode: "replay" | "trace_review", pin: string | null, t = tenant): Promise<string> {
    return (await pool.query(
      `insert into public.eval_cases (tenant, owner_wallet, case_key, manifest_sha256, pin_sha256, mode, use_case_key)
       values ($1, $2, $3, $4, $5, $6, 'fix/red-ci') returning id`,
      [t, owner, key, H("a"), pin, mode],
    )).rows[0].id;
  }

  async function newVariant(cid: string, sha: string, baseline: boolean, t = tenant): Promise<string> {
    return (await pool.query(
      `insert into public.eval_variants (case_id, tenant, variant_sha256, label, change_kind, is_baseline, prediction_sha256)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [cid, t, sha, baseline ? "baseline" : "prompt v2", baseline ? "none" : "prompt", baseline, baseline ? null : H("e")],
    )).rows[0].id;
  }

  /** A stable picture of what 0023 owns: columns, constraints and indexes of its tables, and row counts. */
  async function snapshot() {
    const tables = ["eval_cases", "eval_variants", "grader_versions", "grader_results", "runs", "run_actions"];
    const cols = await pool.query(
      `select table_name, column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = any($1) order by 1, 2`,
      [tables],
    );
    const cons = await pool.query(
      `select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = any($1::regclass[]) order by 1, 2`,
      [tables.map((t) => `public.${t}`)],
    );
    const idx = await pool.query(
      `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = any($1) order by 1, 2`,
      [tables],
    );
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = Number((await pool.query(`select count(*)::int as n from public.${t}`)).rows[0].n);
    return { cols: cols.rows, cons: cons.rows, idx: idx.rows, counts };
  }

  beforeAll(async () => {
    await pool.query(SQL);
    const vendor = await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag]);
    agentId = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'private', 'active') returning id`,
      [vendor.rows[0].id, `m0023 ${tag}`, `bench://${tag}`, owner],
    )).rows[0].id;
    versionId = (await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb) returning id`, [agentId, `prompt-${"d".repeat(33)}`])).rows[0].id;
    releaseId = (await pool.query(`insert into public.release_declarations (agent_id, release_ref) values ($1, 'r1') returning id`, [agentId])).rows[0].id;
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'm0023-test')`, [tag]);

    caseId = await newCase(`${tag}-case`, "replay", H("b"));
    otherCaseId = await newCase(`${tag}-other`, "trace_review", null);
    baselineId = await newVariant(caseId, H("1"), true);
    variantId = await newVariant(caseId, H("2"), false);
    otherVariantId = await newVariant(otherCaseId, H("3"), true);
    graderId = (await pool.query(
      `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256) values ($1, 'hidden-tests', '1.0.0', 'code', $2) returning id`,
      [tenant, H("c")],
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`delete from public.runs where task_pack_id = $1`, [tag]);
    await pool.query(`delete from public.evaluations where owner_wallet = $1`, [owner]);
    await pool.query(`delete from public.eval_cases where owner_wallet = $1`, [owner]);
    await pool.query(`delete from public.grader_versions where tenant in ($1, 'other-tenant') and code_sha256 in ($2, $3)`, [tenant, H("c"), H("9")]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agents where id = $1`, [agentId]);
    await pool.query(`delete from public.vendors where display_name = $1`, [tag]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.end();
  });

  it("applies a second time with no error and changes nothing", async () => {
    const before = await snapshot();
    await pool.query(SQL);
    expect(await snapshot()).toEqual(before);
  });

  it("adds no function and no trigger to the public schema", async () => {
    const triggers = await pool.query(
      `select tgname from pg_trigger where not tgisinternal and tgrelid = any($1::regclass[])`,
      [["public.eval_cases", "public.eval_variants", "public.grader_versions", "public.grader_results"]],
    );
    expect(triggers.rows).toEqual([]);
  });

  it("keeps RLS on for the new tables", async () => {
    const { rows } = await pool.query(
      `select relname, relrowsecurity from pg_class where oid = any($1::regclass[]) order by relname`,
      [["public.eval_cases", "public.eval_variants", "public.grader_versions", "public.grader_results"]],
    );
    expect(rows.every((r: { relrowsecurity: boolean }) => r.relrowsecurity)).toBe(true);
    const policies = await pool.query(
      `select count(*)::int as n from pg_policies where schemaname = 'public'
        and tablename in ('eval_cases', 'eval_variants', 'grader_versions', 'grader_results')`,
    );
    expect(policies.rows[0].n).toBe(0);
  });

  it("allows one baseline per case: a second baseline is a unique violation", async () => {
    await expect(newVariant(caseId, H("4"), true).catch(pgCode)).resolves.toBe("23505");
    // The same variant digest twice in one case is one row.
    await expect(newVariant(caseId, H("2"), false).catch(pgCode)).resolves.toBe("23505");
    const { rows } = await pool.query(`select count(*)::int as n from public.eval_variants where case_id = $1`, [caseId]);
    expect(rows[0].n).toBe(2);
  });

  it("refuses a baseline with a change or a prediction, and a variant without one", async () => {
    const bad: [string, unknown[]][] = [
      [`insert into public.eval_variants (case_id, tenant, variant_sha256, label, change_kind, is_baseline, prediction_sha256)
        values ($1, $2, $3, 'x', 'prompt', true, null)`, [otherCaseId, tenant, H("5")]],
      [`insert into public.eval_variants (case_id, tenant, variant_sha256, label, change_kind, is_baseline, prediction_sha256)
        values ($1, $2, $3, 'x', 'none', false, null)`, [otherCaseId, tenant, H("6")]],
      [`insert into public.eval_variants (case_id, tenant, variant_sha256, label, change_kind, is_baseline, prediction_sha256)
        values ($1, $2, $3, 'x', 'prompt', false, null)`, [otherCaseId, tenant, H("7")]],
      [`insert into public.eval_variants (case_id, tenant, variant_sha256, label, change_kind, is_baseline, prediction_sha256)
        values ($1, $2, $3, E'two\\nlines', 'prompt', false, $4)`, [otherCaseId, tenant, H("8"), H("e")]],
    ];
    for (const [sql, values] of bad) await expect(pool.query(sql, values).catch(pgCode), sql).resolves.toBe("23514");
  });

  it("refuses a replay case with no pin and a bad tenant key", async () => {
    await expect(newCase(`${tag}-nopin`, "replay", null).catch(pgCode)).resolves.toBe("23514");
    await expect(newCase(`${tag}-tenant`, "trace_review", null, "Dev Fellowship").catch(pgCode)).resolves.toBe("23514");
  });

  it("keeps a variant in the tenant of its case", async () => {
    await expect(newVariant(otherCaseId, H("9"), false, "other-tenant").catch(pgCode)).resolves.toBe("23503");
  });

  it("refuses judge fields on a code grader, and takes them on a judge", async () => {
    await expect(pool.query(
      `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256, judge_model_id) values ($1, 'g', '1.0.0', 'code', $2, 'zai/glm-5.3')`,
      [tenant, H("9")],
    ).catch(pgCode)).resolves.toBe("23514");
    const judge = await pool.query(
      `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256, judge_model_id, rubric_sha256, params_sha256, tpr, tnr, test_split_sha256)
       values ($1, 'judge-g', '1.0.0', 'judge', $2, 'zai/glm-5.3', $2, $2, 0.91, 0.88, $2) returning tpr`,
      [tenant, H("9")],
    );
    expect(Number(judge.rows[0].tpr)).toBe(0.91);
  });

  it("refuses a run with a case and no variant, and a run whose variant is of another case", async () => {
    const run = await newRun();
    await expect(pool.query(`update public.runs set case_id = $1 where id = $2`, [caseId, run]).catch(pgCode)).resolves.toBe("23514");
    await expect(pool.query(`update public.runs set case_id = $1, variant_id = $2 where id = $3`, [caseId, otherVariantId, run]).catch(pgCode)).resolves.toBe("23503");
    await pool.query(`update public.runs set case_id = $1, variant_id = $2, infra_ok = true where id = $3`, [caseId, variantId, run]);
    // Each repeat is its own run row of the same variant (plan ADR-1).
    const run2 = await newRun();
    await pool.query(`update public.runs set case_id = $1, variant_id = $2 where id = $3`, [caseId, variantId, run2]);
    const { rows } = await pool.query(`select count(*)::int as n from public.runs where variant_id = $1`, [variantId]);
    expect(rows[0].n).toBe(2);
    // A baseline run of the same case is a third, separate row.
    const run3 = await newRun();
    await pool.query(`update public.runs set case_id = $1, variant_id = $2 where id = $3`, [caseId, baselineId, run3]);
  });

  it("adds a row on a re-grade, gives the API role no UPDATE, and cascades with the run", async () => {
    const run = await newRun();
    const insert = () => pool.query(
      `insert into public.grader_results (tenant, run_id, grader_version_id, pass, score, weight, hard_gate, decisive, infra_ok)
       values ($1, $2, $3, true, 87.5, 1, true, true, true)`,
      [tenant, run, graderId],
    );
    await insert();
    await insert();
    const n = async () => Number((await pool.query(`select count(*)::int as n from public.grader_results where run_id = $1`, [run])).rows[0].n);
    expect(await n()).toBe(2);
    const priv = await pool.query(
      `select has_table_privilege('itera_api_service', 'public.grader_results', 'UPDATE') as upd,
              has_table_privilege('itera_api_service', 'public.grader_results', 'INSERT') as ins`,
    );
    expect(priv.rows[0]).toEqual({ upd: false, ins: true });
    // A grader result in another tenant than its grader version is refused.
    await expect(pool.query(
      `insert into public.grader_results (tenant, run_id, grader_version_id, pass, weight, hard_gate, decisive)
       values ('other-tenant', $1, $2, true, 1, false, true)`,
      [run, graderId],
    ).catch(pgCode)).resolves.toBe("23503");
    await expect(pool.query(
      `insert into public.grader_results (tenant, run_id, grader_version_id, pass, score, weight, hard_gate, decisive)
       values ($1, $2, $3, true, 101, 1, false, true)`,
      [tenant, run, graderId],
    ).catch(pgCode)).resolves.toBe("23514");
    await pool.query(`delete from public.runs where id = $1`, [run]);
    expect(await n()).toBe(0);
  });

  it("takes a tma-trajectory/1 step on run_actions and refuses the forbidden shapes", async () => {
    const run = await newRun();
    const step = (seq: number, cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      return pool.query(
        `insert into public.run_actions (run_id, seq, tool${keys.map((k) => `, ${k}`).join("")})
         values ($1, $2, 'Bash'${keys.map((_, i) => `, $${i + 3}`).join("")})`,
        [run, seq, ...Object.values(cols)],
      );
    };
    await step(1, {
      target: "src/app.ts", ok: true, parent_seq: null, turn: 0, tool_family: "shell", status: "ok", error_class: null,
      duration_ms: 120, tokens_in: 10, tokens_out: 5, target_kind: "file", args_sha256: H("a"), result_sha256: H("b"), retry_of: null,
    });
    await step(2, { ok: false, status: "error", error_class: "tool_error", parent_seq: 1, retry_of: 1, target_kind: "none" });
    // A hosted row (written before 0023, or by the worker without trajectory fields) stays valid.
    await step(3, { target: "npm test", ok: true });
    const bad: Record<string, unknown>[] = [
      { status: "ok", error_class: "timeout" },
      { status: "error", error_class: null },
      { parent_seq: 10 },
      { retry_of: 10 },
      { tool_family: "browser" },
      { target_kind: "secret" },
      { args_sha256: "not-a-digest" },
      { duration_ms: -1 },
    ];
    for (const cols of bad) await expect(step(10, cols).catch(pgCode), JSON.stringify(cols)).resolves.toBe("23514");
  });
});
