/**
 * A recorded session on a trace_review case (plan 20261112-tma-c3-eval-repo-kit-docs, C3-T9) on a real Postgres: the
 * body that `tma eval upload --mode trace_review` sends (one run of the baseline variant "recorded session", the
 * structural trajectory of the session, a code grader and a human label). Runs when ITERA_PG_TEST_URL points at a
 * THROWAWAY Postgres with db/migrations applied up to 0024 (the web3 e2e guard job sets it). Never point it at a real
 * project.
 *
 * Proves the C3-T9 acceptance on the store and the read side:
 *   1. the upload writes ONE `runs` row with case_id and variant_id and N `run_actions` rows, and GET /runs/:id (the
 *      eval-results decorator over PgEvalResultsReader) shows the case, the variant, the graders and the N steps;
 *   2. a human label reads back as a `grader_results` row whose grader version has kind `human`, with its labeler and
 *      reason code; a label added later (--label-only: the same run key, the human grader alone) ADDS one grader row
 *      to the same run, keeps one `runs` row and the N `run_actions` rows; the same body again is `unchanged`.
 * (3., the `prompt` key refused with 400 unknown_key, is a contract check before the store: router.test.ts.)
 */
import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalResultV3 } from "@itera/contracts";
import { validateLocalResultV3 } from "@itera/contracts";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { createEvalResultsRouter, PgEvalResultsReader } from "./eval-results.js";
import { PgSelfDeclaredStore } from "./store.pg.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MODEL = "anthropic/claude-sonnet-4.5";

describe.skipIf(!URL_)("trace_review upload of a recorded session on Postgres (0023 and 0024 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const store = new PgSelfDeclaredStore(pool);
  const reader = new PgEvalResultsReader(() => pool);
  const tag = `sdtr-${randomUUID().slice(0, 8)}`;
  const ALICE = `dfl:${randomUUID()}`;
  const opts = { dryRun: false, perDay: 50, tenant: "devfellowship" };
  const HUMAN = `${tag}-human`;
  const CODE = `${tag}-tests`;
  let agentA = "";
  let taskId = "";
  let vendorId = "";
  let server: Server;
  let base = "";

  const step = (seq: number, over: Record<string, unknown> = {}) => ({
    seq, parent_seq: null, turn: seq, tool: "Read", tool_family: "builtin", status: "ok", error_class: null, duration_ms: 1000,
    tokens_in: null, tokens_out: null, target_kind: "file", target_redacted: "lib/add.js", args_sha256: H("b"), result_sha256: H("c"),
    retry_of: null, ...over,
  });
  const STEPS = [
    step(1),
    step(2, { tool: "Edit" }),
    step(3, { tool: "Bash", tool_family: "shell", target_kind: "command", target_redacted: "npm test", duration_ms: 12000 }),
  ];
  const code = { id: CODE, semver: "1.0.0", code_sha256: H("f"), kind: "code", pass: true, score: 100, weight: 1, hard_gate: true, decisive: true };
  const human = (over: Record<string, unknown> = {}) => ({
    id: HUMAN, semver: "1.0.0", code_sha256: H("9"), kind: "human", pass: false, score: 40, weight: 0, hard_gate: false, decisive: false,
    labeler: "tainan", reason_code: "partial", ...over,
  });
  const run = (graders: unknown[]) => ({
    item_sha256: H("a"), repeat: 1, status: "pass", score: 100, wall_s: 21, cost_usd: null, tokens_in: null, tokens_out: null, error_class: null,
    parts: null, tests: null, infra_ok: true, graders, trajectory: { format: "tma-trajectory/1", steps: STEPS },
  });
  /** The shape of `tma eval upload --mode trace_review` (services/runner/src/cli/eval/trace-review.ts). */
  const body = (graders: unknown[]): LocalResultV3 => {
    const value = {
      format: "tma-local-result/3",
      agent_id: agentA,
      task: { catalog: { slug: tag, version: 1 } },
      metrics_shape: "tma-score/1",
      grader_version: "1.1.0",
      runner: { version: "0.1.0", execution: "external", profile: null, sandbox_image_id: null },
      executor: { model_id: MODEL, provider: "anthropic", route: "openrouter", harness: "claude-code", variant: null, cost_source: "none" },
      ran_from: "2026-11-12T18:00:00.000Z",
      ran_to: "2026-11-12T18:00:21.000Z",
      summary: { score: 100, runs: 1, items: 1 },
      case: { case_key: `${tag}-review`, manifest_sha256: H("1"), origin_pin_sha256: null, mode: "trace_review", use_case_key: "fix/red-ci" },
      variant: {
        agent: { harness: "claude-code", harness_version: "2.1.87", harness_repo_sha: null, model_id: MODEL, rules_sha256: null, skills_sha256: null, mcp_manifest_sha256: null, tools_sha256: null },
        variant_sha256: EMPTY, label: "recorded session", change_kind: "none",
      },
      comparison: { is_baseline: true, prediction_sha256: null },
      runs: [run(graders)],
    };
    const checked = validateLocalResultV3(value);
    if (!checked.ok) throw new Error(`fixture is not a valid tma-local-result/3: ${checked.errors.join("; ")}`);
    return checked.value;
  };
  const count = async (sql: string, values: unknown[]) => Number((await pool.query(sql, values)).rows[0].n);

  beforeAll(async () => {
    resetSchemaFeatures();
    vendorId = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag])).rows[0].id;
    agentA = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'private', 'active') returning id`,
      [vendorId, `${tag} a`, `https://${tag}.example`, ALICE],
    )).rows[0].id;
    await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb)`, [agentA, "c".repeat(40)]);
    // The model of the session as a custom model of the caller (no shared catalog row is touched).
    await pool.query(`insert into public.user_models (owner_wallet, id, label, provider_key, route_key) values ($1, $2, 'Sonnet 4.5', 'anthropic', 'openrouter')`, [ALICE, MODEL]);
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'sdtr-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, name, description, visibility, status) values ($1, 'itera', 'SDTR test task', 'Synthetic.', 'public', 'ready') returning id`,
      [tag],
    )).rows[0].id;
    await pool.query(`insert into public.task_versions (task_id, version, source, pack_id, pack_version, runnable) values ($1, 1, 'curated', $2, '1', true)`, [taskId, tag]);
    // GET /runs/:id as the API serves it: the eval-results decorator in front of the runs router (a stub body here).
    const app = express();
    app.use(createEvalResultsRouter(reader));
    app.get("/runs/:id", (req, res) => {
      res.json({ id: req.params.id });
    });
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query(`delete from public.runs where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.evaluations where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.eval_cases where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.eval_variants where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.grader_versions where grader_id like $1`, [`${tag}-%`]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentA]);
    await pool.query(`delete from public.task_versions where task_id = $1`, [taskId]);
    await pool.query(`delete from public.tasks where id = $1`, [taskId]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.query(`delete from public.user_models where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentA]);
    await pool.query(`delete from public.agents where id = $1`, [agentA]);
    await pool.query(`delete from public.vendors where id = $1`, [vendorId]);
    await pool.end();
  });

  let first: Awaited<ReturnType<typeof store.importResultV2>>;

  it("writes ONE runs row with case_id and variant_id and N run_actions rows", async () => {
    first = await store.importResultV2(ALICE, body([code, human()]), opts);
    expect(first).toMatchObject({ action: "inserted", outcome: "pass", runs: { inserted: 1, updated: 0, unchanged: 0 } });
    expect(first.runIds).toHaveLength(1);
    const runs = (await pool.query(
      `select id, seq, status, case_id, variant_id, prediction_sha256, result_origin from public.runs where evaluation_id = $1`,
      [first.evaluationId],
    )).rows;
    expect(runs).toEqual([{ id: first.runIds[0], seq: 1, status: "pass", case_id: first.caseId, variant_id: first.variantId, prediction_sha256: null, result_origin: "self_declared" }]);
    expect(first.caseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.variantId).toMatch(/^[0-9a-f-]{36}$/);
    const steps = (await pool.query(`select seq, tool, target, status from public.run_actions where run_id = $1 order by seq`, [first.runIds[0]])).rows;
    expect(steps).toEqual([
      { seq: 1, tool: "Read", target: "lib/add.js", status: "ok" },
      { seq: 2, tool: "Edit", target: "lib/add.js", status: "ok" },
      { seq: 3, tool: "Bash", target: "npm test", status: "ok" },
    ]);
    // The recorded session is the baseline of its trace_review case.
    const kase = (await pool.query(`select mode, origin_pin_sha256, baseline_variant_id from public.eval_cases where id = $1`, [first.caseId])).rows[0];
    expect(kase).toEqual({ mode: "trace_review", origin_pin_sha256: null, baseline_variant_id: first.variantId });
    const v = (await pool.query(`select label, change_kind, harness, model_id from public.eval_variants where id = $1`, [first.variantId])).rows[0];
    expect(v).toEqual({ label: "recorded session", change_kind: "none", harness: "claude-code", model_id: MODEL });
  });

  it("reads the human label back as a grader_results row of kind human, with its labeler and reason code", async () => {
    const rows = (await pool.query(
      `select gv.grader_id, gv.kind, gr.pass, gr.score::float8 as score, gr.decisive, gr.labeler, gr.reason_code
         from public.grader_results gr join public.grader_versions gv on gv.id = gr.grader_version_id
        where gr.run_id = $1 order by gv.kind`,
      [first.runIds[0]],
    )).rows;
    expect(rows).toEqual([
      { grader_id: CODE, kind: "code", pass: true, score: 100, decisive: true, labeler: null, reason_code: null },
      { grader_id: HUMAN, kind: "human", pass: false, score: 40, decisive: false, labeler: "tainan", reason_code: "partial" },
    ]);
  });

  it("GET /runs/:id shows the case, the variant, the human grader row and the N steps", async () => {
    const res = await fetch(`${base}/runs/${first.runIds[0]}`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({
      id: first.runIds[0],
      case: { id: first.caseId, mode: "trace_review", baselineVariantId: first.variantId },
      variant: { id: first.variantId, label: "recorded session", changeKind: "none", isBaseline: true },
      predictionSha256: null,
      trajectorySummary: { steps: 3, firstFailureSeq: null, errorClasses: {} },
    });
    expect(j.graders).toHaveLength(2);
    expect(j.graders.find((g: { kind: string }) => g.kind === "human")).toMatchObject({ id: HUMAN, pass: false, score: 40, labeler: "tainan", reasonCode: "partial", decisive: false });
  });

  it("a label added later (--label-only) adds one human grader row to the SAME run; the same body again is unchanged", async () => {
    const later = body([human({ labeler: "sam", reason_code: "wrong_sha", pass: true, score: 90 })]);
    const added = await store.importResultV2(ALICE, later, opts);
    expect(added).toMatchObject({ action: "updated", evaluationId: first.evaluationId, caseId: first.caseId, variantId: first.variantId, runIds: first.runIds, runs: { updated: 1 } });
    expect(await count(`select count(*) as n from public.runs where evaluation_id = $1`, [first.evaluationId])).toBe(1);
    expect(await count(`select count(*) as n from public.run_actions where run_id = $1`, [first.runIds[0]])).toBe(3);
    const labels = (await pool.query(
      `select gr.labeler, gr.reason_code, gr.pass from public.grader_results gr join public.grader_versions gv on gv.id = gr.grader_version_id
        where gr.run_id = $1 and gv.kind = 'human' order by gr.graded_at, gr.id`,
      [first.runIds[0]],
    )).rows;
    expect(labels).toEqual([{ labeler: "tainan", reason_code: "partial", pass: false }, { labeler: "sam", reason_code: "wrong_sha", pass: true }]);
    expect(await count(`select count(*) as n from public.grader_results where run_id = $1`, [first.runIds[0]])).toBe(3);
    // One registry row for the human grader version.
    expect(await count(`select count(*) as n from public.grader_versions where grader_id = $1`, [HUMAN])).toBe(1);
    expect(await store.importResultV2(ALICE, later, opts)).toMatchObject({ action: "unchanged", runs: { unchanged: 1 } });
    expect(await count(`select count(*) as n from public.grader_results where run_id = $1`, [first.runIds[0]])).toBe(3);
  });
});
