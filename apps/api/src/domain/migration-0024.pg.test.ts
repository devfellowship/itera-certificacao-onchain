/**
 * db/migrations/0024_eval_summary_steps_grader_meta.sql against a real Postgres (plan 20261112-tma-c4-result-store-
 * trajectory-upload, tasks T9, T10 and T11). Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with
 * db/migrations applied, as a role that may ALTER the tables (the web3 e2e guard job sets it to its own database).
 * Never point it at a real project: the test applies the migration file.
 *
 * Proves: the file applies a second time with no error and changes nothing (the catalog of the columns and
 * constraints it owns and the row counts are equal before and after); it has no DB function, trigger or procedure and
 * is one transaction; every new column is nullable; the CHECKs take the allowed shapes and refuse the forbidden ones
 * (a task summary with `outcome`, 281 characters, a newline or a non-object; an unknown step kind or turn origin, a
 * negative started_ms; a proof with more caught than planted; calibration on a code grader, with a missing or an extra
 * key; a 61-character note; an e-mail as an author or labeler; an unknown reason code).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL_ = process.env.ITERA_PG_TEST_URL;
const SQL = readFileSync(new URL("../../../../db/migrations/0024_eval_summary_steps_grader_meta.sql", import.meta.url), "utf8");
const H = (c: string) => c.repeat(64);

const NEW_COLUMNS: Record<string, string[]> = {
  eval_cases: ["task_summary"],
  run_actions: ["step_kind", "started_ms", "turn_origin"],
  grader_versions: ["proof_caught", "proof_total", "calibration", "note", "author"],
  grader_results: ["reason_code", "labeler"],
};
const NEW_CONSTRAINTS = [
  "eval_cases_task_summary_check",
  "run_actions_trajectory_v2_check",
  "grader_versions_proof_check",
  "grader_versions_calibration_check",
  "grader_versions_note_check",
  "grader_versions_author_check",
  "grader_results_label_check",
];

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

describe("migration 0024 file", () => {
  it("has no DB function, trigger or procedure", () => {
    expect(SQL).not.toMatch(/create\s+(or\s+replace\s+)?(function|trigger|procedure)/i);
  });
  it("runs in one transaction", () => {
    expect(SQL.match(/^begin;$/gm)?.length).toBe(1);
    expect(SQL.match(/^commit;$/gm)?.length).toBe(1);
    expect(SQL.trimEnd().endsWith("commit;")).toBe(true);
  });
  it("changes no data and adds no table", () => {
    expect(SQL).not.toMatch(/^\s*(insert|update|delete)\s/im);
    expect(SQL).not.toMatch(/create\s+table/i);
  });
});

describe.skipIf(!URL_)("migration 0024 on Postgres", () => {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const tag = `m0024-${randomUUID().slice(0, 8)}`;
  const owner = `dfl:${randomUUID()}`;
  const tenant = "devfellowship";
  let agentId = "";
  let versionId = "";
  let releaseId = "";
  let caseId = "";
  let codeGrader = "";
  let judgeGrader = "";
  let runId = "";

  /** A stable picture of what 0024 owns: its columns and constraints, and the row counts of its tables. */
  async function snapshot() {
    const tables = Object.keys(NEW_COLUMNS);
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
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = Number((await pool.query(`select count(*)::int as n from public.${t}`)).rows[0].n);
    return { cols: cols.rows, cons: cons.rows, counts };
  }

  beforeAll(async () => {
    await pool.query(SQL);
    const vendor = await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag]);
    agentId = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'private', 'active') returning id`,
      [vendor.rows[0].id, `m0024 ${tag}`, `bench://${tag}`, owner],
    )).rows[0].id;
    versionId = (await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb) returning id`, [agentId, `prompt-${"e".repeat(33)}`])).rows[0].id;
    releaseId = (await pool.query(`insert into public.release_declarations (agent_id, release_ref) values ($1, 'r1') returning id`, [agentId])).rows[0].id;
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'm0024-test')`, [tag]);
    const evalId = randomUUID();
    await pool.query(
      `insert into public.evaluations (id, slug, short_id, owner_wallet, agent_id, agent_version_id, model_id, tasks, status, task_count, payment_kind, score, is_public)
       values ($1, $2, $3, $4, $5, $6, 'zai/glm-5.3', '[]'::jsonb, 'review', 1, 'free_byok', 50, false)`,
      [evalId, `${tag}-e`, `S${evalId.replaceAll("-", "").slice(0, 20)}`, owner, agentId, versionId],
    );
    runId = randomUUID();
    await pool.query(
      `insert into public.runs (id, release_declaration_id, task_pack_id, task_pack_version, nonce, status, evidence_manifest, score_total,
         agent_version_id, owner_wallet, evaluation_id, seq)
       values ($1, $2, $3, '1', $4, 'pass', '{}'::jsonb, 50, $5, $6, $7, 1)`,
      [runId, releaseId, tag, `${tag}-${runId}`, versionId, owner, evalId],
    );
    caseId = (await pool.query(
      `insert into public.eval_cases (tenant, owner_wallet, case_key, manifest_sha256, mode, use_case_key)
       values ($1, $2, $3, $4, 'trace_review', 'fix/red-ci') returning id`,
      [tenant, owner, `${tag}-case`, H("a")],
    )).rows[0].id;
    codeGrader = (await pool.query(
      `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256) values ($1, $2, '1.0.0', 'code', $3) returning id`,
      [tenant, `${tag}-code`, H("c")],
    )).rows[0].id;
    judgeGrader = (await pool.query(
      `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256, judge_model_id) values ($1, $2, '1.0.0', 'judge', $3, 'zai/glm-5.3') returning id`,
      [tenant, `${tag}-judge`, H("d")],
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`delete from public.runs where task_pack_id = $1`, [tag]);
    await pool.query(`delete from public.evaluations where owner_wallet = $1`, [owner]);
    await pool.query(`delete from public.eval_cases where owner_wallet = $1`, [owner]);
    await pool.query(`delete from public.grader_versions where grader_id like $1`, [`${tag}-%`]);
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

  it("adds every column as nullable, and every constraint", async () => {
    for (const [table, cols] of Object.entries(NEW_COLUMNS)) {
      const { rows } = await pool.query(
        `select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = any($2)`,
        [table, cols],
      );
      expect(rows.map((r: { column_name: string }) => r.column_name).sort(), table).toEqual([...cols].sort());
      expect(rows.every((r: { is_nullable: string }) => r.is_nullable === "YES"), table).toBe(true);
    }
    const { rows } = await pool.query(`select conname from pg_constraint where conname = any($1)`, [NEW_CONSTRAINTS]);
    expect(rows.map((r: { conname: string }) => r.conname).sort()).toEqual([...NEW_CONSTRAINTS].sort());
  });

  it("adds no trigger to the tables it alters, and the API role still cannot UPDATE grader_results", async () => {
    const triggers = await pool.query(
      `select tgname from pg_trigger where not tgisinternal and tgrelid = any($1::regclass[])`,
      [Object.keys(NEW_COLUMNS).map((t) => `public.${t}`)],
    );
    expect(triggers.rows).toEqual([]);
    const upd = await pool.query(`select has_table_privilege('itera_api_service', 'public.grader_results', 'UPDATE') as upd`);
    expect(upd.rows[0].upd).toBe(false);
  });

  describe("eval_cases.task_summary (T9, Q-T16 = A)", () => {
    const set = (v: unknown) =>
      pool.query(`update public.eval_cases set task_summary = $1::jsonb where id = $2`, [v === null ? null : JSON.stringify(v), caseId]);

    it("stores {before, expected} of 280 characters each, a null field, and null", async () => {
      const t280 = "a".repeat(280);
      await set({ before: t280, expected: `Expected: 200 OK, one row per id; (f) & #1 = 100%` });
      const { rows } = await pool.query(`select task_summary from public.eval_cases where id = $1`, [caseId]);
      expect(rows[0].task_summary.before).toBe(t280);
      await set({ before: "Red CI on main.", expected: null });
      await set({});
      await set(null);
    });

    it("refuses outcome, another key, 281 characters, an empty or non-string field, a newline, a quote and a non-object", async () => {
      const bad: unknown[] = [
        { before: "x", expected: "y", outcome: "merged" },
        { outcome: "merged" },
        { before: "x", note: "y" },
        { before: "a".repeat(281) },
        { expected: "a".repeat(281) },
        { before: "" },
        { before: 12 },
        { before: "two\nlines" },
        { before: 'say "hi"' },
        ["before", "expected"],
        "before",
      ];
      for (const v of bad) await expect(set(v).catch(pgCode), JSON.stringify(v)).resolves.toBe("23514");
    });
  });

  describe("run_actions tma-trajectory/2 columns (T10)", () => {
    let seq = 0;
    const step = (cols: Record<string, unknown>) => {
      seq += 1;
      const keys = Object.keys(cols);
      return pool.query(
        `insert into public.run_actions (run_id, seq, tool${keys.map((k) => `, ${k}`).join("")})
         values ($1, $2, 'Bash'${keys.map((_, i) => `, $${i + 3}`).join("")})`,
        [runId, seq, ...Object.values(cols)],
      );
    };

    it("takes every step kind and turn origin, a start offset, and a row with none of them", async () => {
      for (const k of ["read", "search", "write", "test", "mcp", "shell", "agent", "other"]) await step({ step_kind: k, started_ms: 0, turn_origin: "agent" });
      await step({ step_kind: "test", started_ms: 86_400_000, turn_origin: "human" });
      await step({ turn_origin: "system" });
      await step({ target: "npm test", ok: true });
    });

    it("refuses an unknown step kind or turn origin and a negative or too large started_ms", async () => {
      const bad: Record<string, unknown>[] = [
        { step_kind: "browse" },
        { step_kind: "Test" },
        { turn_origin: "user" },
        { started_ms: -1 },
        { started_ms: 86_400_001 },
      ];
      for (const cols of bad) await expect(step(cols).catch(pgCode), JSON.stringify(cols)).resolves.toBe("23514");
    });
  });

  describe("grader_versions proof, calibration, note, author (T11)", () => {
    const upd = (id: string, cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      return pool.query(
        `update public.grader_versions set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`,
        [id, ...Object.values(cols)],
      );
    };
    const cal = { n_labels: 120, n_test: 86, tp: 40, fn: 3, tn: 39, fp: 4, realigned_at: "2026-11-12" };

    it("stores a proof, a note and an author on a code grader, and a calibration on a judge", async () => {
      await upd(codeGrader, { proof_caught: 3, proof_total: 3, note: "Catches the dup webhook; v2.1 (#12)", author: "claude-main" });
      await upd(codeGrader, { proof_caught: 0, proof_total: 5, author: "dfl:6c4b1a3e-0000-4000-8000-000000000000" });
      await upd(judgeGrader, { calibration: JSON.stringify(cal) });
      await upd(judgeGrader, { calibration: JSON.stringify({ ...cal, realigned_at: null }) });
      const { rows } = await pool.query(`select calibration from public.grader_versions where id = $1`, [judgeGrader]);
      expect(rows[0].calibration.tp).toBe(40);
      await upd(codeGrader, { proof_caught: null, proof_total: null, note: null, author: null });
    });

    it("refuses a broken proof, calibration on a code grader or of the wrong shape, a long note and an e-mail author", async () => {
      const bad: [string, Record<string, unknown>][] = [
        [codeGrader, { proof_caught: 4, proof_total: 3 }],
        [codeGrader, { proof_caught: 1, proof_total: null }],
        [codeGrader, { proof_caught: null, proof_total: 2 }],
        [codeGrader, { proof_caught: 0, proof_total: 0 }],
        [codeGrader, { proof_caught: -1, proof_total: 3 }],
        [codeGrader, { calibration: JSON.stringify(cal) }],
        [judgeGrader, { calibration: JSON.stringify({ ...cal, why: "the judge said" }) }],
        [judgeGrader, { calibration: JSON.stringify({ n_labels: 1, n_test: 1, tp: 1, fn: 0, tn: 0 }) }],
        [judgeGrader, { calibration: JSON.stringify({ ...cal, tp: "40" }) }],
        [judgeGrader, { calibration: JSON.stringify({ ...cal, realigned_at: "yesterday" }) }],
        [judgeGrader, { calibration: JSON.stringify([1, 2]) }],
        [codeGrader, { note: "a".repeat(61) }],
        [codeGrader, { note: "" }],
        [codeGrader, { note: "line\nbreak" }],
        [codeGrader, { author: "tainan@example.com" }],
        [codeGrader, { author: "Tainan" }],
      ];
      for (const [id, cols] of bad) await expect(upd(id, cols).catch(pgCode), JSON.stringify(cols)).resolves.toBe("23514");
    });
  });

  describe("grader_results reason_code and labeler (T11)", () => {
    const insert = (cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      return pool.query(
        `insert into public.grader_results (tenant, run_id, grader_version_id, pass, weight, hard_gate, decisive${keys.map((k) => `, ${k}`).join("")})
         values ($1, $2, $3, false, 1, false, true${keys.map((_, i) => `, $${i + 4}`).join("")})`,
        [tenant, runId, codeGrader, ...Object.values(cols)],
      );
    };

    it("takes every reason code with a labeler, and a row with neither", async () => {
      for (const reason of ["wrong_sha", "no_check", "partial", "other"]) await insert({ reason_code: reason, labeler: "tainan" });
      await insert({});
    });

    it("refuses an unknown reason code and an e-mail labeler", async () => {
      await expect(insert({ reason_code: "vibes" }).catch(pgCode)).resolves.toBe("23514");
      await expect(insert({ labeler: "someone@example.com" }).catch(pgCode)).resolves.toBe("23514");
    });
  });
});
