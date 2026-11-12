/**
 * PgSelfDeclaredStore.importResultV2 and PgEvalResultsReader (plan 20261112-tma-c4-result-store-trajectory-upload,
 * tasks T3 and T8) against a real Postgres. Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations
 * applied up to 0023 (the web3 e2e guard job sets it). Never point it at a real project.
 *
 * Proves (the plan's C4 exit signal, hermetic): two agent variants of one case are two evaluations; one agent variant
 * on two cases is one variant row and two crossings (parent plan ADR-26); repeat 3 is three
 * `runs` rows (seq 1..3) with their grader rows and trajectory rows; the same body again is `unchanged`; a new
 * repeat adds a row; a changed run ADDS grader rows (a re-grade) and replaces its trajectory; a second baseline
 * is 409 baseline_exists (the baseline lives on the case); a changed prediction of a crossing is 409; a dry run writes nothing; a v1 upload still writes one evaluation = one run with no
 * case; the reader returns the case, the variant, the grader rows, the trajectory summary and the case detail
 * (n, pass rate, baseline) to the owner only.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalResult, LocalResultV2 } from "@itera/contracts";
import { validateLocalResultV2 } from "@itera/contracts";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { PgEvalResultsReader } from "./eval-results.js";
import { PgSelfDeclaredStore } from "./store.pg.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);

describe.skipIf(!URL_)("PgSelfDeclaredStore v2 and PgEvalResultsReader on Postgres (0023 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const store = new PgSelfDeclaredStore(pool);
  const reader = new PgEvalResultsReader(() => pool);
  const tag = `sd2-${randomUUID().slice(0, 8)}`;
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  const opts = { dryRun: false, perDay: 50, tenant: "devfellowship" };
  let agentA = "";
  let taskId = "";
  const vendorIds: string[] = [];

  const step = (seq: number, over: Record<string, unknown> = {}) => ({
    seq, parent_seq: null, turn: seq, tool: "Edit", tool_family: "builtin", status: "ok", error_class: null, duration_ms: 120,
    tokens_in: 900, tokens_out: 80, target_kind: "file", target_redacted: "src/webhook/handler.ts", args_sha256: H("b"), result_sha256: H("c"),
    retry_of: null, ...over,
  });
  const run = (repeat: number, score: number, over: Record<string, unknown> = {}) => ({
    item_sha256: H("a"), repeat, status: score === 100 ? "pass" : "fail", score, wall_s: 212, cost_usd: 0.031, tokens_in: 51234, tokens_out: 3120,
    error_class: null,
    parts: { public_behavior: 20, hidden_behavior: score === 100 ? 50 : 30, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
    infra_ok: true,
    graders: [{ id: "hidden-tests", semver: "2.0.0", code_sha256: H("f"), kind: "code", pass: score === 100, score, weight: 1, hard_gate: true, decisive: true }],
    trajectory: {
      format: "tma-trajectory/1",
      steps: [
        step(1),
        step(2, { tool: "Bash", tool_family: "shell", status: "error", error_class: "tool_error", target_kind: "command", target_redacted: "npm test <args>" }),
        step(3, { tool: "Bash", tool_family: "shell", target_kind: "command", target_redacted: "npm test <args>", retry_of: 2 }),
      ],
    },
    ...over,
  });
  const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const AGENT = {
    harness: "opencode", harness_version: "1.18.31", harness_repo_sha: "0".repeat(40), model_id: "opencode-go/deepseek-v4-pro",
    rules_sha256: H("6"), skills_sha256: H("7"), mcp_manifest_sha256: H("8"), tools_sha256: null,
  };
  const BASELINE = { agent: AGENT, variant_sha256: EMPTY, label: "baseline", change_kind: "none" };
  const IS_BASELINE = { is_baseline: true, prediction_sha256: null };
  const VARIANT = { agent: AGENT, variant_sha256: H("6"), label: "skill v2", change_kind: "skill" };
  const PREDICTED = { is_baseline: false, prediction_sha256: H("4") };

  const v2 = (over: Record<string, unknown> = {}): LocalResultV2 => {
    const value: Record<string, unknown> = {
      format: "tma-local-result/2",
      agent_id: agentA,
      task: { catalog: { slug: tag, version: 1 } },
      metrics_shape: "tma-score/1",
      grader_version: "1.1.0",
      runner: { version: "0.1.0", execution: "tma-sandbox", profile: "opencode", sandbox_image_id: `sha256:${H("d")}` },
      executor: { model_id: "opencode-go/deepseek-v4-pro", provider: "deepseek", route: "opencode-go", harness: "opencode 1.18.31", variant: null, cost_source: "metered" },
      ran_from: "2026-11-12T12:00:00Z",
      ran_to: "2026-11-12T12:20:00Z",
      summary: { score: 93.3, runs: 3, items: 1 },
      case: { case_key: `${tag}-case`, manifest_sha256: H("1"), origin_pin_sha256: H("2"), mode: "replay", use_case_key: "fix/prod-bug" },
      variant: BASELINE,
      comparison: IS_BASELINE,
      runs: [run(1, 100), run(2, 80), run(3, 100)],
      ...over,
    };
    value.summary = { ...(value.summary as Record<string, number>), runs: (value.runs as unknown[]).length };
    // The fixtures are real contract bodies: the router would accept them.
    const checked = validateLocalResultV2(value);
    if (!checked.ok) throw new Error(`fixture is not a valid tma-local-result/2: ${checked.errors.join("; ")}`);
    return checked.value;
  };

  const count = async (sql: string, values: unknown[]) => Number((await pool.query(sql, values)).rows[0].n);

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
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'sd2-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, name, description, visibility, status) values ($1, 'itera', 'SD2 test task', 'Synthetic.', 'public', 'ready') returning id`,
      [tag],
    )).rows[0].id;
    await pool.query(
      `insert into public.task_versions (task_id, version, source, pack_id, pack_version, runnable) values ($1, 1, 'curated', $2, '1', true)`,
      [taskId, tag],
    );
  });

  afterAll(async () => {
    await pool.query(`delete from public.runs where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.evaluations where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.eval_cases where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.eval_variants where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.grader_versions gv where gv.code_sha256 = $1 and not exists (select 1 from public.grader_results gr where gr.grader_version_id = gv.id)`, [H("f")]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentA]);
    await pool.query(`delete from public.task_versions where task_id = $1`, [taskId]);
    await pool.query(`delete from public.tasks where id = $1`, [taskId]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentA]);
    await pool.query(`delete from public.agents where id = $1`, [agentA]);
    await pool.query(`delete from public.vendors where id = any($1::uuid[])`, [vendorIds]);
    await pool.end();
  });

  let baseline: Awaited<ReturnType<typeof store.importResultV2>>;

  it("writes repeat 3 as three runs (seq 1..3), each with its grader row and trajectory rows", async () => {
    expect(await reader.ready()).toBe(true);
    baseline = await store.importResultV2(ALICE, v2(), opts);
    expect(baseline).toMatchObject({ action: "inserted", outcome: "fail", runs: { inserted: 3, updated: 0, unchanged: 0 } });
    const runs = (await pool.query(
      `select id, seq, status, case_id, variant_id, infra_ok, result_origin, evaluation_id from public.runs where evaluation_id = $1 order by seq`,
      [baseline.evaluationId],
    )).rows;
    expect(runs.map((r) => [r.seq, r.status])).toEqual([[1, "pass"], [2, "fail"], [3, "pass"]]);
    expect(runs.map((r) => r.id)).toEqual(baseline.runIds);
    expect(runs.every((r) => r.case_id === baseline.caseId && r.variant_id === baseline.variantId && r.infra_ok === true && r.result_origin === "self_declared")).toBe(true);
    expect(await count(`select count(*) as n from public.grader_results where run_id = any($1::uuid[])`, [baseline.runIds])).toBe(3);
    const steps = (await pool.query(
      `select seq, tool, target, ok, status, error_class, retry_of, args_sha256 from public.run_actions where run_id = $1 order by seq`,
      [baseline.runIds[0]],
    )).rows;
    expect(steps).toEqual([
      { seq: 1, tool: "Edit", target: "src/webhook/handler.ts", ok: true, status: "ok", error_class: null, retry_of: null, args_sha256: H("b") },
      { seq: 2, tool: "Bash", target: "npm test <args>", ok: false, status: "error", error_class: "tool_error", retry_of: null, args_sha256: H("b") },
      { seq: 3, tool: "Bash", target: "npm test <args>", ok: true, status: "ok", error_class: null, retry_of: 2, args_sha256: H("b") },
    ]);
    const ev = (await pool.query(
      `select status, payment_kind, result_origin, is_public, task_count, pass_count, fail_count, score::float8 as score from public.evaluations where id = $1`,
      [baseline.evaluationId],
    )).rows[0];
    expect(ev).toEqual({ status: "graded", payment_kind: "none", result_origin: "self_declared", is_public: false, task_count: 3, pass_count: 2, fail_count: 1, score: 93.3 });
  });

  it("answers unchanged for the same body and adds a row for a new repeat", async () => {
    expect(await store.importResultV2(ALICE, v2(), opts)).toMatchObject({ action: "unchanged", evaluationId: baseline.evaluationId, runs: { unchanged: 3 } });
    const four = await store.importResultV2(ALICE, v2({ runs: [run(1, 100), run(2, 80), run(3, 100), run(4, 100)], summary: { score: 95, runs: 4, items: 1 } }), opts);
    expect(four).toMatchObject({ action: "updated", runs: { inserted: 1, unchanged: 3 } });
    expect(four.runIds.slice(0, 3)).toEqual(baseline.runIds);
    expect(await count(`select count(*) as n from public.runs where evaluation_id = $1`, [baseline.evaluationId])).toBe(4);
    expect((await pool.query(`select seq from public.runs where id = $1`, [four.runIds[3]])).rows[0].seq).toBe(4);
  });

  it("adds grader rows on a re-grade and replaces the trajectory of the changed run", async () => {
    const regraded = run(2, 100, { trajectory: { format: "tma-trajectory/1", steps: [step(1)] } });
    const r = await store.importResultV2(ALICE, v2({ runs: [run(1, 100), regraded, run(3, 100)] }), opts);
    expect(r).toMatchObject({ action: "updated", runs: { updated: 1, unchanged: 2 } });
    const run2 = baseline.runIds[1]!;
    const grades = (await pool.query(`select pass, score::float8 as score from public.grader_results where run_id = $1 order by graded_at, id`, [run2])).rows;
    expect(grades).toHaveLength(2);
    expect(grades.map((g) => g.pass).sort()).toEqual([false, true]);
    expect(await count(`select count(*) as n from public.run_actions where run_id = $1`, [run2])).toBe(1);
    expect((await pool.query(`select status from public.runs where id = $1`, [run2])).rows[0].status).toBe("pass");
    // The grader version row is shared: one registry row for hidden-tests@2.0.0.
    expect(await count(`select count(*) as n from public.grader_versions where tenant = 'devfellowship' and grader_id = 'hidden-tests' and code_sha256 = $1`, [H("f")])).toBe(1);
  });

  it("writes a second variant of the same case as a second evaluation, and refuses a second baseline", async () => {
    const other = await store.importResultV2(ALICE, v2({ variant: VARIANT, comparison: PREDICTED, runs: [run(1, 100), run(2, 100)] }), opts);
    expect(other.action).toBe("inserted");
    expect(other.evaluationId).not.toBe(baseline.evaluationId);
    expect(other.caseId).toBe(baseline.caseId);
    expect(other.variantId).not.toBe(baseline.variantId);
    expect(await count(`select count(*) as n from public.eval_cases where owner_wallet = $1`, [ALICE])).toBe(1);
    expect(await count(`select count(*) as n from public.evaluations where owner_wallet = $1`, [ALICE])).toBe(2);
    expect((await pool.query(`select baseline_variant_id from public.eval_cases where id = $1`, [baseline.caseId])).rows[0].baseline_variant_id).toBe(baseline.variantId);
    const otherAgent = { ...BASELINE, agent: { ...AGENT, harness_repo_sha: "1".repeat(40) } };
    await expect(store.importResultV2(ALICE, v2({ variant: otherAgent }), opts))
      .rejects.toMatchObject({ status: 409, code: "baseline_exists" });
    await expect(store.importResultV2(ALICE, v2({ variant: { ...VARIANT, change_kind: "prompt" }, comparison: PREDICTED }), opts))
      .rejects.toMatchObject({ status: 409, code: "variant_conflict" });
    await expect(store.importResultV2(ALICE, v2({ comparison: PREDICTED }), opts))
      .rejects.toMatchObject({ status: 409, code: "variant_conflict" });
    await expect(store.importResultV2(ALICE, v2({ variant: VARIANT, comparison: { is_baseline: false, prediction_sha256: H("9") }, runs: [run(1, 100), run(2, 100)] }), opts))
      .rejects.toMatchObject({ status: 409, code: "prediction_conflict" });
    // The refused uploads wrote nothing: one case's baseline, two variants.
    expect(await count(`select count(*) as n from public.eval_variants where owner_wallet = $1`, [ALICE])).toBe(2);
    const preds = (await pool.query(`select distinct prediction_sha256 from public.runs where evaluation_id = $1`, [other.evaluationId])).rows;
    expect(preds).toEqual([{ prediction_sha256: H("4") }]);
  });

  it("writes nothing on a dry run", async () => {
    const before = await count(`select count(*) as n from public.runs where owner_wallet = $1`, [ALICE]);
    const d = await store.importResultV2(ALICE, v2({ variant: { ...VARIANT, variant_sha256: H("8") }, comparison: PREDICTED }), { ...opts, dryRun: true });
    expect(d).toMatchObject({ action: "inserted", dryRun: true });
    expect(await count(`select count(*) as n from public.runs where owner_wallet = $1`, [ALICE])).toBe(before);
    expect(await count(`select count(*) as n from public.eval_variants where variant_sha256 = $1`, [H("8")])).toBe(0);
  });

  it("keeps v1: one evaluation = one run, no case, no grader row", async () => {
    const value = v2();
    const v1 = {
      ...value, format: "tma-local-result/1", case: undefined, variant: undefined, comparison: undefined,
      runs: value.runs.map(({ infra_ok: _i, graders: _g, trajectory: _t, ...rest }) => rest),
    } as unknown as LocalResult;
    delete (v1 as unknown as Record<string, unknown>).case;
    delete (v1 as unknown as Record<string, unknown>).variant;
    delete (v1 as unknown as Record<string, unknown>).comparison;
    const o = await store.importResult(ALICE, { ...v1, executor: { ...v1.executor, model_id: "opencode-go/glm-5.3" } }, { dryRun: false, perDay: 50 });
    expect(o.runId).toBe(o.evaluationId);
    const r = (await pool.query(`select case_id, variant_id, prediction_sha256, infra_ok, seq from public.runs where evaluation_id = $1`, [o.evaluationId])).rows;
    expect(r).toEqual([{ case_id: null, variant_id: null, prediction_sha256: null, infra_ok: null, seq: 1 }]);
    expect(await count(`select count(*) as n from public.grader_results where run_id = $1`, [o.runId])).toBe(0);
  });

  it("reads the case, variant, grader rows and trajectory summary back", async () => {
    const cv = await reader.caseOfEvaluation(baseline.evaluationId);
    expect(cv).toMatchObject({
      case: { id: baseline.caseId, caseKey: `${tag}-case`, mode: "replay", useCaseKey: "fix/prod-bug", originPinSha256: H("2"), baselineVariantId: baseline.variantId },
      variant: { id: baseline.variantId, isBaseline: true, changeKind: "none", agent: { harness: "opencode", modelId: "opencode-go/deepseek-v4-pro", mcpManifestSha256: H("8"), toolsSha256: null } },
      predictionSha256: null,
    });
    expect(cv!.variant.agentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await reader.caseOfRun(baseline.runIds[0]!)).toEqual(cv);
    const results = await reader.resultsOfRuns(baseline.runIds);
    expect(results.get(baseline.runIds[0]!)).toMatchObject({
      graders: [{ id: "hidden-tests", semver: "2.0.0", kind: "code", pass: true, score: 100, weight: 1, hardGate: true, decisive: true, infraOk: true }],
      trajectorySummary: { steps: 3, firstFailureSeq: 2, errorClasses: { tool_error: 1 } },
    });
    expect(results.get(baseline.runIds[1]!)?.graders).toHaveLength(2);
  });

  it("lists the variants of a case with n, pass rate and the baseline, to the owner only", async () => {
    const detail = await reader.caseDetail(baseline.caseId, ALICE);
    expect(detail).not.toBeNull();
    expect(detail!.baselineVariantId).toBe(baseline.variantId);
    expect(detail!.variants.map((v) => ({ id: v.id, isBaseline: v.isBaseline, n: v.n, pass: v.pass, passRate: v.passRate }))).toEqual([
      { id: baseline.variantId, isBaseline: true, n: 4, pass: 4, passRate: 1 },
      { id: expect.any(String), isBaseline: false, n: 2, pass: 2, passRate: 1 },
    ]);
    expect(detail!.variants[0]!.evaluationIds).toEqual([baseline.evaluationId]);
    expect(await reader.caseDetail(baseline.caseId, BOB)).toBeNull();
  });

  it("one agent variant on a second case: the same variant row, a second crossing; each case counts its own runs", async () => {
    const other = await store.importResultV2(ALICE, v2({
      variant: VARIANT, comparison: PREDICTED, runs: [run(1, 0)],
      case: { case_key: `${tag}-case-2`, manifest_sha256: H("3"), origin_pin_sha256: null, mode: "trace_review", use_case_key: "fix" },
    }), opts);
    const first = await reader.caseDetail(baseline.caseId, ALICE);
    const firstVariant = first!.variants.find((v) => !v.isBaseline)!;
    expect(other.variantId).toBe(firstVariant.id);
    expect(other.caseId).not.toBe(baseline.caseId);
    expect(firstVariant).toMatchObject({ n: 2, pass: 2, predictionSha256: H("4") });
    const second = await reader.caseDetail(other.caseId, ALICE);
    expect(second!.baselineVariantId).toBeNull();
    expect(second!.variants.map((v) => ({ id: v.id, isBaseline: v.isBaseline, n: v.n, fail: v.fail }))).toEqual([{ id: other.variantId, isBaseline: false, n: 1, fail: 1 }]);
    expect(await count(`select count(*) as n from public.eval_variants where owner_wallet = $1`, [ALICE])).toBe(2);
  });

  it("deletes the grader rows and trajectory rows with the run", async () => {
    const ids = baseline.runIds;
    await pool.query(`delete from public.runs where evaluation_id = $1`, [baseline.evaluationId]);
    expect(await count(`select count(*) as n from public.grader_results where run_id = any($1::uuid[])`, [ids])).toBe(0);
    expect(await count(`select count(*) as n from public.run_actions where run_id = any($1::uuid[])`, [ids])).toBe(0);
  });

  it("records who registered a grader version (created_by = the user id of the principal), and keeps the first author", async () => {
    const row = (await pool.query(
      `select created_by from public.grader_versions where tenant = 'devfellowship' and grader_id = 'hidden-tests' and code_sha256 = $1`,
      [H("f")],
    )).rows[0];
    expect(row.created_by).toBe(ALICE.slice("dfl:".length));
    // A second user that uploads the same grader id/semver/digest gets the same row; the creator does not change.
    await pool.query(`update public.grader_versions set created_by = $1 where tenant = 'devfellowship' and grader_id = 'hidden-tests' and code_sha256 = $2`, [randomUUID(), H("f")]);
    const before = (await pool.query(`select created_by from public.grader_versions where grader_id = 'hidden-tests' and code_sha256 = $1`, [H("f")])).rows[0].created_by;
    await store.importResultV2(ALICE, v2({ runs: [run(1, 100), run(2, 80), run(3, 100), run(4, 100)], summary: { score: 95, runs: 4, items: 1 } }), opts);
    const after = (await pool.query(`select created_by from public.grader_versions where grader_id = 'hidden-tests' and code_sha256 = $1`, [H("f")])).rows[0].created_by;
    expect(after).toBe(before);
  });
});
