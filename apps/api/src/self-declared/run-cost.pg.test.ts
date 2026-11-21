/**
 * PgRunCostStore (POST /eval-results/run-cost, plan 20261112-tma-c7-model-comparison-per-use-case, C7-COST) against a real
 * Postgres. Runs when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations applied up to 0023 (the
 * web3 e2e guard job sets it). Never point it at a real project.
 *
 * The rows are what a producer upload wrote: runs with tokens and no cost. Proves (the C7-COST acceptance): a dry run
 * writes nothing; a real call sets ONLY model_cost_usd and model_cost_source = 'derived' (every other column of each run,
 * every grader_results row, every run_actions row and the evaluation row are byte-equal before and after, so a cost
 * update cannot change a grade); the cost is the server's own derivedCostUsd; a second call is `unchanged`; a run that
 * already has another cost is 409 cost_exists and nothing is written; one entry that matches no run makes the whole call
 * 409 with nothing written; another owner gets 404.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalResultV2, RunCostBody } from "@itera/contracts";
import { validateLocalResultV2 } from "@itera/contracts";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { PgRunCostStore } from "./run-cost.pg.js";
import { SelfDeclaredError } from "./store.js";
import { PgSelfDeclaredStore } from "./store.pg.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);

describe.skipIf(!URL_)("PgRunCostStore on Postgres (0023 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const uploads = new PgSelfDeclaredStore(pool);
  const store = new PgRunCostStore(pool);
  const tag = `rc7-${randomUUID().slice(0, 8)}`;
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  const opts = { dryRun: false, perDay: 50, tenant: "devfellowship" };
  const MODEL = "zai/glm-5.3";
  const TOKENS: Array<[number, number, number, number]> = [
    [1_000_000, 50_000, 600_000, 100_000], // 1.41 USD at the fixture price
    [400_000, 20_000, 0, 0],
    [250_000, 10_000, 100_000, 0],
  ];
  const PRICE = { model_id: MODEL, input: 2, cache_read: 0.1, cache_write: 2.5, output: 10, source_url: "https://example.test/pricing", as_of: "2026-11-21", table_sha256: H("a") };
  let agentId = "";
  let taskId = "";
  let evaluationId = "";
  const vendorIds: string[] = [];

  const run = (repeat: number, tokensIn: number, tokensOut: number, score: number) => ({
    item_sha256: H("a"), repeat, status: score === 100 ? "pass" : "fail", score, wall_s: 212, cost_usd: null, tokens_in: tokensIn, tokens_out: tokensOut,
    error_class: null,
    parts: { public_behavior: 20, hidden_behavior: score === 100 ? 50 : 30, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
    infra_ok: true,
    graders: [{ id: "hidden-tests", semver: "2.0.0", code_sha256: H("f"), kind: "code", pass: score === 100, score, weight: 1, hard_gate: true, decisive: true }],
    trajectory: null,
  });
  const AGENT = {
    harness: "opencode", harness_version: null, harness_repo_sha: null, model_id: MODEL,
    rules_sha256: null, skills_sha256: null, mcp_manifest_sha256: null, tools_sha256: null,
  };
  const body = (over: Partial<RunCostBody> = {}): RunCostBody => ({
    format: "tma-run-cost/1",
    evaluation_id: evaluationId,
    price: PRICE,
    runs: TOKENS.map(([i, o, r, w]) => ({ tokens_in: i, tokens_out: o, cache_read_tokens: r, cache_write_tokens: w })),
    ...over,
  });

  /** Everything of the evaluation except the two cost columns: the runs, every grade row, every step row, the evaluation. */
  const snapshot = async () => ({
    runs: (await pool.query(`select to_jsonb(r) - 'model_cost_usd' - 'model_cost_source' as j from public.runs r where evaluation_id = $1 order by seq`, [evaluationId])).rows.map((x) => x.j),
    grades: (await pool.query(
      `select to_jsonb(g) as j from public.grader_results g join public.runs r on r.id = g.run_id where r.evaluation_id = $1 order by r.seq, g.id`,
      [evaluationId],
    )).rows.map((x) => x.j),
    steps: (await pool.query(`select to_jsonb(a) as j from public.run_actions a join public.runs r on r.id = a.run_id where r.evaluation_id = $1 order by r.seq, a.id`, [evaluationId])).rows.map((x) => x.j),
    evaluation: (await pool.query(`select to_jsonb(e) as j from public.evaluations e where id = $1`, [evaluationId])).rows[0].j,
  });
  const costs = async () => (await pool.query(`select model_cost_usd as c, model_cost_source as s from public.runs where evaluation_id = $1 order by seq`, [evaluationId])).rows.map((r) => [r.c === null ? null : Number(r.c), r.s]);

  beforeAll(async () => {
    resetSchemaFeatures();
    const vendor = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag])).rows[0].id;
    vendorIds.push(vendor);
    agentId = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'private', 'active') returning id`,
      [vendor, `${tag} a`, `https://${tag}.example`, ALICE],
    )).rows[0].id;
    await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb)`, [agentId, "c".repeat(40)]);
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'rc7-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, name, description, visibility, status) values ($1, 'itera', 'RC7 test task', 'Synthetic.', 'public', 'ready') returning id`,
      [tag],
    )).rows[0].id;
    await pool.query(`insert into public.task_versions (task_id, version, source, pack_id, pack_version, runnable) values ($1, 1, 'curated', $2, '1', true)`, [taskId, tag]);
    const value = {
      format: "tma-local-result/2",
      agent_id: agentId,
      task: { catalog: { slug: tag, version: 1 } },
      metrics_shape: "tma-score/1",
      grader_version: "1.1.0",
      runner: { version: "0.1.0", execution: "external", profile: null, sandbox_image_id: null },
      executor: { model_id: MODEL, provider: null, route: "zai", harness: "opencode", variant: null, cost_source: "none" },
      ran_from: "2026-11-12T12:00:00Z",
      ran_to: "2026-11-12T12:20:00Z",
      summary: { score: 93.3, runs: 3, items: 1 },
      case: { case_key: `${tag}-case`, manifest_sha256: H("1"), origin_pin_sha256: H("2"), mode: "replay", use_case_key: "fix/prod-bug" },
      variant: { agent: AGENT, variant_sha256: H("6"), label: "glm c7", change_kind: "harness" },
      comparison: { is_baseline: false, prediction_sha256: H("4") },
      runs: TOKENS.map(([i, o], n) => run(n + 1, i, o, n === 1 ? 80 : 100)),
    };
    const checked = validateLocalResultV2(value);
    if (!checked.ok) throw new Error(`fixture is not a valid tma-local-result/2: ${checked.errors.join("; ")}`);
    const out = await uploads.importResultV2(ALICE, checked.value as LocalResultV2, opts);
    evaluationId = out.evaluationId;
  });

  afterAll(async () => {
    await pool.query(`delete from public.runs where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.evaluations where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.eval_cases where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.eval_variants where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.grader_versions gv where gv.code_sha256 = $1 and not exists (select 1 from public.grader_results gr where gr.grader_version_id = gv.id)`, [H("f")]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.task_versions where task_id = $1`, [taskId]);
    await pool.query(`delete from public.tasks where id = $1`, [taskId]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentId]);
    await pool.query(`delete from public.agents where id = $1`, [agentId]);
    await pool.query(`delete from public.vendors where id = any($1::uuid[])`, [vendorIds]);
    await pool.end();
  });

  it("starts with three runs, tokens and no cost", async () => {
    expect(await costs()).toEqual([[null, "none"], [null, "none"], [null, "none"]]);
  });

  it("a dry run matches and prices the runs and writes nothing", async () => {
    const before = await snapshot();
    const out = await store.applyRunCost(ALICE, body(), { dryRun: true });
    expect(out).toMatchObject({ matched: 3, updated: 3, unchanged: 0 });
    expect(out.runs[0]!.costUsd).toBe(1.41);
    expect(await costs()).toEqual([[null, "none"], [null, "none"], [null, "none"]]);
    expect(await snapshot()).toEqual(before);
  });

  it("a real call sets ONLY the cost and its source; a grade, a step, a digest and the evaluation do not change", async () => {
    const before = await snapshot();
    expect(before.grades.length).toBe(3);
    const out = await store.applyRunCost(ALICE, body({ dry_run: false }), { dryRun: false });
    expect(out).toMatchObject({ matched: 3, updated: 3, unchanged: 0 });
    // 1.41 | 400k in at 2 + 20k out at 10 = 1.0 | 150k fresh at 2 + 100k read at 0.1 + 10k out at 10 = 0.41
    expect(await costs()).toEqual([[1.41, "derived"], [1, "derived"], [0.41, "derived"]]);
    expect(await snapshot()).toEqual(before);
  });

  it("a second call is unchanged", async () => {
    const out = await store.applyRunCost(ALICE, body({ dry_run: false }), { dryRun: false });
    expect(out).toMatchObject({ matched: 3, updated: 0, unchanged: 3 });
    expect(await costs()).toEqual([[1.41, "derived"], [1, "derived"], [0.41, "derived"]]);
  });

  it("a run with another cost is 409 cost_exists and is never overwritten", async () => {
    await pool.query(`update public.runs set model_cost_usd = 0.5, model_cost_source = 'metered' where evaluation_id = $1 and seq = 2`, [evaluationId]);
    await expect(store.applyRunCost(ALICE, body({ dry_run: false }), { dryRun: false })).rejects.toMatchObject({ status: 409, code: "cost_exists" });
    expect(await costs()).toEqual([[1.41, "derived"], [0.5, "metered"], [0.41, "derived"]]);
    await pool.query(`update public.runs set model_cost_usd = null, model_cost_source = 'none' where evaluation_id = $1`, [evaluationId]);
  });

  it("one entry that matches no run makes the whole call 409, and nothing is written", async () => {
    const bad = body({ dry_run: false });
    bad.runs = [...bad.runs.slice(0, 2), { tokens_in: 7, tokens_out: 7, cache_read_tokens: 0, cache_write_tokens: 0 }];
    await expect(store.applyRunCost(ALICE, bad, { dryRun: false })).rejects.toMatchObject({ status: 409, code: "run_not_found" });
    expect(await costs()).toEqual([[null, "none"], [null, "none"], [null, "none"]]);
  });

  it("another owner gets 404, and a price for another model matches no run", async () => {
    await expect(store.applyRunCost(BOB, body({ dry_run: false }), { dryRun: false })).rejects.toBeInstanceOf(SelfDeclaredError);
    await expect(store.applyRunCost(BOB, body({ dry_run: false }), { dryRun: false })).rejects.toMatchObject({ status: 404, code: "evaluation_not_found" });
    await expect(store.applyRunCost(ALICE, body({ price: { ...PRICE, model_id: "codex/gpt-5.6-sol" } }), { dryRun: false })).rejects.toMatchObject({ code: "run_not_found" });
    expect(await costs()).toEqual([[null, "none"], [null, "none"], [null, "none"]]);
  });
});
