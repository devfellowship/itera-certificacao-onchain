/**
 * The 0024 fields of a tma-local-result/2 upload on a real Postgres (plan 20261112-tma-c4-result-store-trajectory-upload,
 * tasks T9, T10 and T11): the task summary of the case, the tma-trajectory/2 step columns, the grader version proof,
 * calibration, note and author, and the label reason and labeler of a grader result. Runs when ITERA_PG_TEST_URL
 * points at a THROWAWAY Postgres with db/migrations applied up to 0024 (the web3 e2e guard job sets it). Never point it
 * at a real project.
 *
 * Proves: a 280-character `before` is stored and GET /eval-cases/:id data (the reader) returns the task summary; the
 * first summary of a case stays and another one is 409 case_conflict, while an upload with no summary is fine; the
 * grader version fields are written once, filled when empty, and another value is 409 grader_conflict; the reason
 * code and the labeler are on the grader result row; a tma-trajectory/2 step writes step_kind, started_ms and
 * turn_origin, and a tma-trajectory/1 step leaves them null; the reader returns every new field.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalResultV2 } from "@itera/contracts";
import { validateLocalResultV2 } from "@itera/contracts";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { PgEvalResultsReader } from "./eval-results.js";
import { PgSelfDeclaredStore } from "./store.pg.js";
import { SelfDeclaredError } from "./store.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);

describe.skipIf(!URL_)("tma-local-result/2 with the 0024 fields on Postgres", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const store = new PgSelfDeclaredStore(pool);
  const reader = new PgEvalResultsReader(() => pool);
  const tag = `sd24-${randomUUID().slice(0, 8)}`;
  const ALICE = `dfl:${randomUUID()}`;
  const opts = { dryRun: false, perDay: 50, tenant: "devfellowship" };
  let agentA = "";
  let taskId = "";
  let vendorId = "";

  const CODE_GRADER = `${tag}-tests`;
  const JUDGE = `${tag}-judge`;
  const CAL = { n_labels: 120, n_test: 86, tp: 40, fn: 3, tn: 39, fp: 4, realigned_at: "2026-11-12" };
  const step = (seq: number, over: Record<string, unknown> = {}) => ({
    seq, parent_seq: null, turn: seq, tool: "Edit", tool_family: "builtin", status: "ok", error_class: null, duration_ms: 120,
    tokens_in: 900, tokens_out: 80, target_kind: "file", target_redacted: "src/webhook/handler.ts", args_sha256: H("b"), result_sha256: H("c"),
    retry_of: null, ...over,
  });
  const code = (over: Record<string, unknown> = {}) => ({
    id: CODE_GRADER, semver: "2.1.0", code_sha256: H("f"), kind: "code", pass: true, score: 100, weight: 1, hard_gate: true, decisive: true,
    proof: { caught: 3, total: 3 }, note: "Catches the dup webhook (#12)", author: "claude-main", ...over,
  });
  const judge = (over: Record<string, unknown> = {}) => ({
    id: JUDGE, semver: "1.0.0", code_sha256: H("e"), kind: "judge", pass: true, score: null, weight: 0, hard_gate: false, decisive: false,
    calibration: CAL, reason_code: "wrong_sha", labeler: "tainan", ...over,
  });
  const run = (repeat: number, over: Record<string, unknown> = {}) => ({
    item_sha256: H("a"), repeat, status: "pass", score: 100, wall_s: 212, cost_usd: 0.031, tokens_in: 51234, tokens_out: 3120, error_class: null,
    parts: { public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
    infra_ok: true,
    graders: [code(), judge()],
    trajectory: {
      format: "tma-trajectory/2",
      steps: [
        { ...step(1, { tool: "Read", target_kind: "file" }), step_kind: "read", started_ms: 0, turn_origin: "human" },
        { ...step(2, { tool: "Bash", tool_family: "shell", target_kind: "command", target_redacted: "npm test <args>" }), step_kind: "test", started_ms: 1500, turn_origin: "agent" },
        { ...step(3), step_kind: "write", started_ms: null, turn_origin: null },
      ],
    },
    ...over,
  });
  const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const AGENT = {
    harness: "opencode", harness_version: "1.18.31", harness_repo_sha: "0".repeat(40), model_id: "opencode-go/deepseek-v4-pro",
    rules_sha256: H("6"), skills_sha256: H("7"), mcp_manifest_sha256: null, tools_sha256: null,
  };
  const BEFORE = "a".repeat(280);
  const SUMMARY = { before: BEFORE, expected: "200 OK and one ledger row per webhook id" };
  const kase = (caseKey: string, summary: unknown) => ({
    case_key: caseKey, manifest_sha256: H("1"), origin_pin_sha256: H("2"), mode: "replay", use_case_key: "fix/prod-bug",
    ...(summary === undefined ? {} : { task_summary: summary }),
  });

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
      summary: { score: 100, runs: 1, items: 1 },
      case: kase(`${tag}-case`, SUMMARY),
      variant: { agent: AGENT, variant_sha256: EMPTY, label: "baseline", change_kind: "none" },
      comparison: { is_baseline: true, prediction_sha256: null },
      runs: [run(1)],
      ...over,
    };
    value.summary = { ...(value.summary as Record<string, number>), runs: (value.runs as unknown[]).length };
    const checked = validateLocalResultV2(value);
    if (!checked.ok) throw new Error(`fixture is not a valid tma-local-result/2: ${checked.errors.join("; ")}`);
    return checked.value;
  };
  const refused = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof SelfDeclaredError ? `${e.status} ${e.code}` : String(e)));

  beforeAll(async () => {
    resetSchemaFeatures();
    vendorId = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag])).rows[0].id;
    agentA = (await pool.query(
      `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
       values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'private', 'active') returning id`,
      [vendorId, `${tag} a`, `https://${tag}.example`, ALICE],
    )).rows[0].id;
    await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb)`, [agentA, "c".repeat(40)]);
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'sd24-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, name, description, visibility, status) values ($1, 'itera', 'SD24 test task', 'Synthetic.', 'public', 'ready') returning id`,
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
    await pool.query(`delete from public.grader_versions where grader_id like $1`, [`${tag}-%`]);
    await pool.query(`delete from public.release_declarations where agent_id = $1`, [agentA]);
    await pool.query(`delete from public.task_versions where task_id = $1`, [taskId]);
    await pool.query(`delete from public.tasks where id = $1`, [taskId]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.query(`delete from public.agent_versions where agent_id = $1`, [agentA]);
    await pool.query(`delete from public.agents where id = $1`, [agentA]);
    await pool.query(`delete from public.vendors where id = $1`, [vendorId]);
    await pool.end();
  });

  let first: Awaited<ReturnType<typeof store.importResultV2>>;

  it("stores the task summary (280 characters), the grader version and label fields, and the tma-trajectory/2 columns", async () => {
    first = await store.importResultV2(ALICE, v2(), opts);
    expect(first).toMatchObject({ action: "inserted", runs: { inserted: 1 } });
    const c = (await pool.query(`select task_summary from public.eval_cases where id = $1`, [first.caseId])).rows[0];
    expect(c.task_summary).toEqual(SUMMARY);
    const gv = (await pool.query(
      `select grader_id, proof_caught, proof_total, calibration, note, author from public.grader_versions where grader_id like $1 order by grader_id`,
      [`${tag}-%`],
    )).rows;
    expect(gv).toEqual([
      { grader_id: JUDGE, proof_caught: null, proof_total: null, calibration: CAL, note: null, author: null },
      { grader_id: CODE_GRADER, proof_caught: 3, proof_total: 3, calibration: null, note: "Catches the dup webhook (#12)", author: "claude-main" },
    ]);
    const gr = (await pool.query(
      `select gv.grader_id, gr.reason_code, gr.labeler from public.grader_results gr join public.grader_versions gv on gv.id = gr.grader_version_id
        where gr.run_id = $1 order by gv.grader_id`,
      [first.runIds[0]],
    )).rows;
    expect(gr).toEqual([
      { grader_id: JUDGE, reason_code: "wrong_sha", labeler: "tainan" },
      { grader_id: CODE_GRADER, reason_code: null, labeler: null },
    ]);
    const steps = (await pool.query(`select seq, step_kind, started_ms, turn_origin from public.run_actions where run_id = $1 order by seq`, [first.runIds[0]])).rows;
    expect(steps).toEqual([
      { seq: 1, step_kind: "read", started_ms: 0, turn_origin: "human" },
      { seq: 2, step_kind: "test", started_ms: 1500, turn_origin: "agent" },
      { seq: 3, step_kind: "write", started_ms: null, turn_origin: null },
    ]);
  });

  it("returns the task summary on the case (GET /eval-cases/:id data) and the new grader fields on the run", async () => {
    const detail = await reader.caseDetail(first.caseId, ALICE);
    expect(detail?.taskSummary).toEqual(SUMMARY);
    expect((await reader.caseOfRun(first.runIds[0]!))?.case.taskSummary).toEqual(SUMMARY);
    const results = (await reader.resultsOfRuns(first.runIds)).get(first.runIds[0]!)!;
    const byId = Object.fromEntries(results.graders.map((g) => [g.id, g]));
    expect(byId[CODE_GRADER]).toMatchObject({ proof: { caught: 3, total: 3 }, calibration: null, note: "Catches the dup webhook (#12)", author: "claude-main", reasonCode: null, labeler: null });
    expect(byId[JUDGE]).toMatchObject({
      proof: null, calibration: { nLabels: 120, nTest: 86, tp: 40, fn: 3, tn: 39, fp: 4, realignedAt: "2026-11-12" }, reasonCode: "wrong_sha", labeler: "tainan",
    });
  });

  it("keeps the first task summary: another one is 409 case_conflict, no summary is fine", async () => {
    const other = v2({ case: kase(`${tag}-case`, { before: "Something else.", expected: null }), runs: [run(2)] });
    expect(await refused(store.importResultV2(ALICE, other, opts))).toBe("409 case_conflict");
    expect(await store.importResultV2(ALICE, v2({ case: kase(`${tag}-case`, undefined), runs: [run(1)] }), opts)).toMatchObject({ action: "unchanged" });
    expect((await pool.query(`select task_summary from public.eval_cases where id = $1`, [first.caseId])).rows[0].task_summary).toEqual(SUMMARY);
    // A case first uploaded with no summary gets one from a later upload.
    const bare = await store.importResultV2(ALICE, v2({ case: kase(`${tag}-bare`, undefined) }), opts);
    expect((await pool.query(`select task_summary from public.eval_cases where id = $1`, [bare.caseId])).rows[0].task_summary).toBeNull();
    await store.importResultV2(ALICE, v2({ case: kase(`${tag}-bare`, { before: null, expected: "Green CI." }) }), opts);
    expect((await pool.query(`select task_summary from public.eval_cases where id = $1`, [bare.caseId])).rows[0].task_summary).toEqual({ before: null, expected: "Green CI." });
  });

  it("writes the grader version fields once: another proof is 409 grader_conflict, an empty field is filled", async () => {
    const changed = v2({ case: kase(`${tag}-g1`, undefined), runs: [run(1, { graders: [code({ proof: { caught: 2, total: 3 } })] })] });
    expect(await refused(store.importResultV2(ALICE, changed, opts))).toBe("409 grader_conflict");
    const otherNote = v2({ case: kase(`${tag}-g2`, undefined), runs: [run(1, { graders: [code({ note: "Another note" })] })] });
    expect(await refused(store.importResultV2(ALICE, otherNote, opts))).toBe("409 grader_conflict");
    // The same version with no fields at all is fine, and changes nothing.
    const silent = v2({ case: kase(`${tag}-g3`, undefined), runs: [run(1, { graders: [code({ proof: null, note: null, author: null })] })] });
    expect(await store.importResultV2(ALICE, silent, opts)).toMatchObject({ action: "inserted" });
    const row = (await pool.query(`select proof_caught, proof_total, note from public.grader_versions where grader_id = $1`, [CODE_GRADER])).rows[0];
    expect(row).toEqual({ proof_caught: 3, proof_total: 3, note: "Catches the dup webhook (#12)" });
    // A new version (semver) with no proof, then the proof arrives: it is filled in place.
    const v3 = (proof: unknown) => v2({ case: kase(`${tag}-g4`, undefined), runs: [run(1, { graders: [code({ semver: "2.2.0", proof, note: null, author: null })] })] });
    await store.importResultV2(ALICE, v3(null), opts);
    await store.importResultV2(ALICE, v3({ caught: 4, total: 5 }), opts);
    const filled = (await pool.query(`select proof_caught, proof_total from public.grader_versions where grader_id = $1 and semver = '2.2.0'`, [CODE_GRADER])).rows[0];
    expect(filled).toEqual({ proof_caught: 4, proof_total: 5 });
  });

  it("a tma-trajectory/1 step on a 0024 database leaves the three columns null", async () => {
    const v1Steps = { format: "tma-trajectory/1", steps: [step(1), step(2)] };
    const r = await store.importResultV2(ALICE, v2({ case: kase(`${tag}-t1`, undefined), runs: [run(1, { trajectory: v1Steps, graders: [] })] }), opts);
    const steps = (await pool.query(`select seq, step_kind, started_ms, turn_origin from public.run_actions where run_id = $1 order by seq`, [r.runIds[0]])).rows;
    expect(steps).toEqual([
      { seq: 1, step_kind: null, started_ms: null, turn_origin: null },
      { seq: 2, step_kind: null, started_ms: null, turn_origin: null },
    ]);
  });
});
