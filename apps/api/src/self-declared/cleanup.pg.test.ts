/**
 * PgEvalCleanupStore (POST /eval-results/cleanup, plan 20261112-tma-c4-result-store-trajectory-upload, C4-T13) against a
 * real Postgres. Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations applied up to 0023 (the
 * web3 e2e guard job sets it). Never point it at a real project.
 *
 * The rows are the ones that the real import path writes (PgSelfDeclaredStore.importResultV2). "Orphaned" rows are what
 * the T7 production proof left: upload, then DELETE the evaluation (its runs and gradings go), and the case, the agent
 * variant and the grader version stay.
 *
 * Proves: the listing and the default dry run delete nothing; the owner deletes an orphaned case with its baseline
 * variant and an orphaned grader version in one transaction; another principal's ids are not_found and stay (both
 * ways); a case, variant and grader version that a run or a grading references are refused with their reason and stay;
 * a calibrated grader version is refused; the DELETE statements refuse a forged plan on their own (the SQL guards are
 * a second check, not decoration).
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalResultV2 } from "@itera/contracts";
import { validateLocalResultV2 } from "@itera/contracts";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { CleanupConflictError, type CleanupPlan } from "./cleanup.js";
import { PgEvalCleanupStore } from "./cleanup.pg.js";
import { PgSelfDeclaredStore } from "./store.pg.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);
const TENANT = "devfellowship";

describe.skipIf(!URL_)("PgEvalCleanupStore on Postgres (0023 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const imports = new PgSelfDeclaredStore(pool);
  const store = new PgEvalCleanupStore(pool);
  const tag = `cl-${randomUUID().slice(0, 8)}`;
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  const opts = { dryRun: false, perDay: 500, tenant: TENANT };
  const vendorIds: string[] = [];
  let agentA = "";
  let taskId = "";

  const AGENT = {
    harness: "opencode", harness_version: "1.18.31", harness_repo_sha: "0".repeat(40), model_id: "opencode-go/deepseek-v4-pro",
    rules_sha256: H("6"), skills_sha256: H("7"), mcp_manifest_sha256: H("8"), tools_sha256: null,
  };
  const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  const step = (seq: number) => ({
    seq, parent_seq: null, turn: seq, tool: "Edit", tool_family: "builtin", status: "ok", error_class: null, duration_ms: 120,
    tokens_in: 900, tokens_out: 80, target_kind: "file", target_redacted: "src/webhook/handler.ts", args_sha256: H("b"), result_sha256: H("c"),
    retry_of: null,
  });

  /** A one-run v2 upload: one case (`name`), its baseline variant, one grader version (`grader`). */
  const upload = (name: string, grader: string, agent = AGENT): LocalResultV2 => {
    const value = {
      format: "tma-local-result/2",
      agent_id: agentA,
      task: { catalog: { slug: tag, version: 1 } },
      metrics_shape: "tma-score/1",
      grader_version: "1.1.0",
      runner: { version: "0.1.0", execution: "tma-sandbox", profile: "opencode", sandbox_image_id: `sha256:${H("d")}` },
      executor: { model_id: "opencode-go/deepseek-v4-pro", provider: "deepseek", route: "opencode-go", harness: "opencode 1.18.31", variant: null, cost_source: "metered" },
      ran_from: "2026-11-12T12:00:00Z",
      ran_to: "2026-11-12T12:20:00Z",
      summary: { score: 100, runs: 1, items: 1 },
      case: { case_key: `${tag}-${name}`, manifest_sha256: H("1"), origin_pin_sha256: H("2"), mode: "replay", use_case_key: "fix/prod-bug" },
      variant: { agent, variant_sha256: EMPTY, label: `${name} baseline`, change_kind: "none" },
      comparison: { is_baseline: true, prediction_sha256: null },
      runs: [{
        item_sha256: H("a"), repeat: 1, status: "pass", score: 100, wall_s: 212, cost_usd: 0.031, tokens_in: 51234, tokens_out: 3120, error_class: null,
        parts: { public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
        infra_ok: true,
        trajectory: { format: "tma-trajectory/1", steps: [step(1)] },
        graders: [{ id: grader, semver: "2.0.0", code_sha256: H("f"), kind: "code", pass: true, score: 100, weight: 1, hard_gate: true, decisive: true }],
      }],
    };
    const checked = validateLocalResultV2(value);
    if (!checked.ok) throw new Error(`fixture is not a valid tma-local-result/2: ${checked.errors.join("; ")}`);
    return checked.value;
  };

  const one = async (sql: string, values: unknown[]) => (await pool.query(sql, values)).rows[0];
  const count = async (sql: string, values: unknown[]) => Number((await one(`select count(*) as n from ${sql}`, values)).n);
  const exists = async (table: "eval_cases" | "eval_variants" | "grader_versions", id: string) => (await count(`public.${table} where id = $1`, [id])) === 1;
  const graderOf = async (graderId: string) => (await one(`select id from public.grader_versions where tenant = $1 and grader_id = $2`, [TENANT, graderId])).id as string;

  interface Fixture { caseId: string; variantId: string; graderId: string; evaluationId: string }
  /** Upload as ALICE. orphan: delete the evaluation afterwards (what DELETE /evaluations/:id does), leaving the three rows. */
  const make = async (name: string, orphan: boolean, agent = AGENT): Promise<Fixture> => {
    const r = await imports.importResultV2(ALICE, upload(name, `${tag}-g-${name}`, agent), opts);
    const f = { caseId: r.caseId, variantId: r.variantId, graderId: await graderOf(`${tag}-g-${name}`), evaluationId: r.evaluationId };
    if (orphan) {
      await pool.query(`delete from public.runs where evaluation_id = $1`, [r.evaluationId]);
      await pool.query(`delete from public.evaluations where id = $1`, [r.evaluationId]);
    }
    return f;
  };

  let orphan: Fixture;
  let kept: Fixture;
  let bobCase = "";
  let bobVariant = "";
  let judgeGrader = "";

  beforeAll(async () => {
    resetSchemaFeatures();
    const vendor = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag])).rows[0].id;
    vendorIds.push(vendor);
    agentA = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'private', 'active') returning id`,
      [vendor, `${tag} a`, `https://${tag}.example`, ALICE],
    )).rows[0].id;
    await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb)`, [agentA, "c".repeat(40)]);
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'cl-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, name, description, visibility, status) values ($1, 'itera', 'CL test task', 'Synthetic.', 'public', 'ready') returning id`,
      [tag],
    )).rows[0].id;
    await pool.query(
      `insert into public.task_versions (task_id, version, source, pack_id, pack_version, runnable) values ($1, 1, 'curated', $2, '1', true)`,
      [taskId, tag],
    );
    orphan = await make("orphan", true);
    // Another base agent version = another variant row (an agent variant is independent of the case: one row can serve many cases).
    kept = await make("kept", false, { ...AGENT, rules_sha256: H("5") });
    // Bob's orphaned case and variant, inserted directly (an upload needs an agent that Bob owns).
    bobVariant = (await pool.query(
      `insert into public.eval_variants (tenant, owner_wallet, agent_sha256, harness, model_id, variant_sha256, label, change_kind)
       values ($1, $2, $3, 'opencode', 'opencode-go/deepseek-v4-pro', $4, 'bob variant', 'prompt') returning id`,
      [TENANT, BOB, H("9"), H("9")],
    )).rows[0].id;
    bobCase = (await pool.query(
      `insert into public.eval_cases (tenant, owner_wallet, case_key, manifest_sha256, mode, use_case_key, origin_pin_sha256)
       values ($1, $2, $3, $4, 'replay', 'fix/prod-bug', $5) returning id`,
      [TENANT, BOB, `${tag}-bob`, H("1"), H("2")],
    )).rows[0].id;
    // A calibrated judge grader version, unreferenced.
    judgeGrader = (await pool.query(
      `insert into public.grader_versions (tenant, grader_id, semver, kind, code_sha256, judge_model_id, rubric_sha256, tpr, tnr)
       values ($1, $2, '1.0.0', 'judge', $3, 'opencode-go/deepseek-v4-pro', $4, 0.9, 0.9) returning id`,
      [TENANT, `${tag}-judge`, H("e"), H("d")],
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`delete from public.runs where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.evaluations where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.eval_cases where owner_wallet = any($1::text[])`, [[ALICE, BOB]]);
    await pool.query(`delete from public.eval_variants where owner_wallet = any($1::text[])`, [[ALICE, BOB]]);
    await pool.query(`delete from public.grader_versions where grader_id like $1`, [`${tag}-%`]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentA]);
    await pool.query(`delete from public.task_versions where task_id = $1`, [taskId]);
    await pool.query(`delete from public.tasks where id = $1`, [taskId]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentA]);
    await pool.query(`delete from public.agents where id = $1`, [agentA]);
    await pool.query(`delete from public.vendors where id = any($1::uuid[])`, [vendorIds]);
    await pool.end();
  });

  const none = { caseIds: null, variantIds: null, graderVersionIds: null };
const ADMIN = { dryRun: true, graderAdmin: true };
const USER = { dryRun: true, graderAdmin: false };

  it("the fixture is what the T7 proof left: the evaluation is gone, the case, the variant and the grader version stay", async () => {
    expect(await count(`public.runs where case_id = $1`, [orphan.caseId])).toBe(0);
    expect(await exists("eval_cases", orphan.caseId)).toBe(true);
    expect(await exists("eval_variants", orphan.variantId)).toBe(true);
    expect(await exists("grader_versions", orphan.graderId)).toBe(true);
    expect((await one(`select baseline_variant_id from public.eval_cases where id = $1`, [orphan.caseId])).baseline_variant_id).toBe(orphan.variantId);
  });

  it("lists the caller's deletable rows and deletes nothing (listing, then the default dry run)", async () => {
    const listing = await store.cleanup(ALICE, TENANT, none, ADMIN);
    expect(listing.deleted).toBe(false);
    expect(listing.plan.cases.map((c) => c.id)).toEqual([orphan.caseId]);
    expect(listing.plan.variants.map((v) => v.id)).toEqual([orphan.variantId]);
    expect(listing.plan.graderVersions.filter((g) => g.graderId.startsWith(tag)).map((g) => g.id).sort()).toEqual([orphan.graderId]);
    expect(listing.plan.refused).toEqual([]);
    const named = await store.cleanup(ALICE, TENANT, { caseIds: [orphan.caseId], variantIds: [orphan.variantId], graderVersionIds: [orphan.graderId] }, ADMIN);
    expect(named.deleted).toBe(false);
    expect(named.plan.refused).toEqual([]);
    for (const [t, id] of [["eval_cases", orphan.caseId], ["eval_variants", orphan.variantId], ["grader_versions", orphan.graderId]] as const) expect(await exists(t, id)).toBe(true);
  });

  it("another principal's ids are not_found in both directions, and the rows stay", async () => {
    const asBob = await store.cleanup(BOB, TENANT, { caseIds: [orphan.caseId], variantIds: [orphan.variantId], graderVersionIds: null }, { ...USER, dryRun: false });
    expect(asBob.deleted).toBe(false);
    expect(asBob.plan.refused.map((r) => `${r.kind}:${r.reason}`)).toEqual(["case:not_found", "variant:not_found"]);
    const asAlice = await store.cleanup(ALICE, TENANT, { caseIds: [bobCase], variantIds: [bobVariant], graderVersionIds: null }, { ...USER, dryRun: false });
    expect(asAlice.deleted).toBe(false);
    expect(asAlice.plan.refused.map((r) => `${r.kind}:${r.reason}`)).toEqual(["case:not_found", "variant:not_found"]);
    expect(await exists("eval_cases", orphan.caseId)).toBe(true);
    expect(await exists("eval_variants", orphan.variantId)).toBe(true);
    expect(await exists("eval_cases", bobCase)).toBe(true);
    expect(await exists("eval_variants", bobVariant)).toBe(true);
    // The tenant is part of the owner check too: the same owner in another tenant sees nothing.
    const other = await store.cleanup(ALICE, "other-tenant", { caseIds: [orphan.caseId], variantIds: null, graderVersionIds: [orphan.graderId] }, { ...ADMIN, dryRun: false });
    expect(other.plan.refused.map((r) => `${r.kind}:${r.reason}`)).toEqual(["case:not_found", "grader_version:not_found"]);
    expect(await exists("eval_cases", orphan.caseId)).toBe(true);
    expect(await exists("grader_versions", orphan.graderId)).toBe(true);
  });

  it("refuses a case, variant and grader version that a run or a grading references, with the reason", async () => {
    const r = await store.cleanup(
      ALICE, TENANT,
      { caseIds: [kept.caseId], variantIds: [kept.variantId], graderVersionIds: [kept.graderId, judgeGrader] },
      { ...ADMIN, dryRun: false },
    );
    expect(r.deleted).toBe(false);
    expect(r.plan.refused).toEqual([
      { kind: "case", id: kept.caseId, reason: "referenced_by_runs", detail: { runs: 1 } },
      { kind: "variant", id: kept.variantId, reason: "referenced_by_runs", detail: { runs: 1 } },
      { kind: "grader_version", id: kept.graderId, reason: "referenced_by_grader_results", detail: { results: 1 } },
      { kind: "grader_version", id: judgeGrader, reason: "grader_has_calibration", detail: {} },
    ]);
    for (const [t, id] of [["eval_cases", kept.caseId], ["eval_variants", kept.variantId], ["grader_versions", kept.graderId], ["grader_versions", judgeGrader]] as const) expect(await exists(t, id)).toBe(true);
  });

  it("a variant that stays as a case's baseline is refused (the case is not in the request)", async () => {
    const r = await store.cleanup(ALICE, TENANT, { caseIds: null, variantIds: [orphan.variantId], graderVersionIds: null }, { ...USER, dryRun: false });
    expect(r.deleted).toBe(false);
    expect(r.plan.refused).toEqual([{ kind: "variant", id: orphan.variantId, reason: "baseline_of_case", detail: { case_ids: [orphan.caseId] } }]);
    expect(await exists("eval_variants", orphan.variantId)).toBe(true);
  });

  it("the DELETE statements refuse a forged plan on their own (the SQL guards)", async () => {
    const forge = (over: Partial<CleanupPlan>): CleanupPlan => ({ listing: false, cases: [], variants: [], graderVersions: [], refused: [], ...over });
    const attempt = async (owner: string, tenant: string, plan: CleanupPlan, admin = true) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await (store as unknown as { apply(c: unknown, o: string, t: string, p: CleanupPlan, admin: boolean): Promise<void> }).apply(c, owner, tenant, plan, admin);
        await c.query("commit");
        return "applied";
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        // A case or variant that a run references is refused by the SQL guard, or by the RESTRICT foreign key (23503):
        // either way it is not deleted.
        return e instanceof CleanupConflictError || (e as { code?: string }).code === "23503" ? "refused" : `error:${String(e)}`;
      } finally {
        c.release();
      }
    };
    // A caller that is not an admin: even the free grader version never reaches the DELETE.
    expect(await attempt(ALICE, TENANT, forge({ graderVersions: [{ id: orphan.graderId, graderId: "x", semver: "2.0.0" }] }), false)).toBe("refused");
    expect(await exists("grader_versions", orphan.graderId)).toBe(true);
    expect(await attempt(ALICE, TENANT, forge({ cases: [{ id: kept.caseId, caseKey: "x" }] }))).toBe("refused");
    expect(await attempt(ALICE, TENANT, forge({ variants: [{ id: kept.variantId, label: "x" }] }))).toBe("refused");
    expect(await attempt(ALICE, TENANT, forge({ graderVersions: [{ id: kept.graderId, graderId: "x", semver: "1.0.0" }] }))).toBe("refused");
    expect(await attempt(ALICE, TENANT, forge({ graderVersions: [{ id: judgeGrader, graderId: "x", semver: "1.0.0" }] }))).toBe("refused");
    // Not the owner: the SQL guard refuses a case that is free but belongs to Bob.
    expect(await attempt(ALICE, TENANT, forge({ cases: [{ id: bobCase, caseKey: "x" }] }))).toBe("refused");
    expect(await attempt(ALICE, TENANT, forge({ variants: [{ id: bobVariant, label: "x" }] }))).toBe("refused");
    // A variant that is still a baseline.
    expect(await attempt(ALICE, TENANT, forge({ variants: [{ id: orphan.variantId, label: "x" }] }))).toBe("refused");
    for (const [t, id] of [["eval_cases", kept.caseId], ["eval_variants", kept.variantId], ["grader_versions", kept.graderId], ["grader_versions", judgeGrader], ["eval_cases", bobCase], ["eval_variants", bobVariant], ["eval_variants", orphan.variantId]] as const) {
      expect(await exists(t, id)).toBe(true);
    }
  });

  it("deny direction: a caller that is not an admin lists no grader version, and naming grader ids with dry_run false is admin_only with 0 rows deleted", async () => {
    const listing = await store.cleanup(ALICE, TENANT, none, USER);
    expect(listing.plan.graderVersions).toEqual([]);
    // The caller that does not own the rows is no different: the registry has no owner, so ownership is not the gate.
    for (const who of [ALICE, BOB]) {
      const r = await store.cleanup(who, TENANT, { caseIds: null, variantIds: null, graderVersionIds: [orphan.graderId, kept.graderId, judgeGrader] }, { ...USER, dryRun: false });
      expect(r.deleted).toBe(false);
      expect(r.plan.graderVersions).toEqual([]);
      expect(r.plan.refused.map((x) => `${x.kind}:${x.reason}`)).toEqual(["grader_version:admin_only", "grader_version:admin_only", "grader_version:admin_only"]);
    }
    for (const id of [orphan.graderId, kept.graderId, judgeGrader]) expect(await exists("grader_versions", id)).toBe(true);
  });

  it("the owner deletes the orphaned case, its baseline variant and the grader version in one transaction", async () => {
    const r = await store.cleanup(ALICE, TENANT, { caseIds: [orphan.caseId], variantIds: [orphan.variantId], graderVersionIds: [orphan.graderId] }, { ...ADMIN, dryRun: false });
    expect(r.deleted).toBe(true);
    expect(r.plan.refused).toEqual([]);
    expect([r.plan.cases.map((c) => c.id), r.plan.variants.map((v) => v.id), r.plan.graderVersions.map((g) => g.id)]).toEqual([[orphan.caseId], [orphan.variantId], [orphan.graderId]]);
    for (const [t, id] of [["eval_cases", orphan.caseId], ["eval_variants", orphan.variantId], ["grader_versions", orphan.graderId]] as const) expect(await exists(t, id)).toBe(false);
    // Everything else is untouched: the referenced rows, the calibrated grader, Bob's rows.
    for (const [t, id] of [["eval_cases", kept.caseId], ["eval_variants", kept.variantId], ["grader_versions", kept.graderId], ["grader_versions", judgeGrader], ["eval_cases", bobCase], ["eval_variants", bobVariant]] as const) {
      expect(await exists(t, id)).toBe(true);
    }
    // A second delete finds nothing: not_found, not an error.
    const again = await store.cleanup(ALICE, TENANT, { caseIds: [orphan.caseId], variantIds: null, graderVersionIds: null }, { ...USER, dryRun: false });
    expect(again).toMatchObject({ deleted: false, plan: { refused: [{ kind: "case", id: orphan.caseId, reason: "not_found" }] } });
  });
});
