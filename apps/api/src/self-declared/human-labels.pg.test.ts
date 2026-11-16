/**
 * The C6-T3 human label store on a real Postgres (plan 20261112-tma-c6-judge-calibration, T3). Runs when ITERA_PG_TEST_URL
 * points at a THROWAWAY Postgres with db/migrations applied up to 0024 (the web3 e2e guard job sets it).
 *
 * The run comes from the real trace_review upload (PgSelfDeclaredStore.importResultV2, the body of
 * `tma eval upload --mode trace_review`) in a random tenant, with a judge result and a workflow label that disagree.
 * Proves: a label written through PgHumanLabelStore reads back with its labeler and reason code, on the human label
 * grader `label-<judge>@1.0.0` (one grader version for two labels); runTenant names the case tenant (so a second tenant gets
 * 403 in the router); the review queue shows the disagreement, the folded steps and the caller's own label.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateLocalResultV3, type LocalResultV3 } from "@itera/contracts";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { humanLabelDigest, LABEL_GRADER_SEMVER, labelGraderId, PgHumanLabelStore } from "./human-labels.js";
import { PgSelfDeclaredStore } from "./store.pg.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MODEL = "anthropic/claude-sonnet-4.5";
const JUDGE = "async-wait-lifecycle";

describe.skipIf(!URL_)("PgHumanLabelStore on Postgres (0023 and 0024 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const upload = new PgSelfDeclaredStore(pool);
  const store = new PgHumanLabelStore(() => pool);
  const tag = `hl-${randomUUID().slice(0, 8)}`;
  const TENANT = tag;
  const ALICE = `dfl:${randomUUID()}`;
  const LABELER = `person:${randomUUID()}`;
  let agentA = "";
  let taskId = "";
  let vendorId = "";
  let runId = "";

  const step = (seq: number, over: Record<string, unknown> = {}) => ({
    seq, parent_seq: null, turn: seq, tool: "Read", tool_family: "builtin", status: "ok", error_class: null, duration_ms: 1000,
    tokens_in: null, tokens_out: null, target_kind: "file", target_redacted: "lib/add.js", args_sha256: H("b"), result_sha256: H("c"),
    retry_of: null, ...over,
  });
  const g = (kind: string, pass: boolean, over: Record<string, unknown> = {}) => ({
    id: kind === "judge" ? JUDGE : labelGraderId(JUDGE), semver: kind === "judge" ? "0.1.0" : LABEL_GRADER_SEMVER,
    code_sha256: kind === "judge" ? H("7") : humanLabelDigest(labelGraderId(JUDGE), LABEL_GRADER_SEMVER), kind, pass,
    score: pass ? 100 : 0, weight: 0, hard_gate: false, decisive: false, ...over,
  });
  const body = (): LocalResultV3 => {
    const value = {
      format: "tma-local-result/3", agent_id: agentA, task: { catalog: { slug: tag, version: 1 } }, metrics_shape: "tma-score/1", grader_version: "1.1.0",
      runner: { version: "0.1.0", execution: "external", profile: null, sandbox_image_id: null },
      executor: { model_id: MODEL, provider: "anthropic", route: "openrouter", harness: "claude-code", variant: null, cost_source: "none" },
      ran_from: "2026-11-12T18:00:00.000Z", ran_to: "2026-11-12T18:00:21.000Z", summary: { score: 100, runs: 1, items: 1 },
      case: { case_key: `${tag}-review`, manifest_sha256: H("1"), origin_pin_sha256: null, mode: "trace_review", use_case_key: "fix/red-ci" },
      variant: {
        agent: { harness: "claude-code", harness_version: "2.1.87", harness_repo_sha: null, model_id: MODEL, rules_sha256: null, skills_sha256: null, mcp_manifest_sha256: null, tools_sha256: null },
        variant_sha256: EMPTY, label: "recorded session", change_kind: "none",
      },
      comparison: { is_baseline: true, prediction_sha256: null },
      runs: [{
        item_sha256: H("a"), repeat: 1, status: "pass", score: 100, wall_s: 21, cost_usd: null, tokens_in: null, tokens_out: null, error_class: null,
        parts: null, tests: null, infra_ok: true,
        graders: [g("judge", true), g("human", false, { labeler: "workflow:reverted" })],
        trajectory: { format: "tma-trajectory/1", steps: [step(1), step(2, { tool: "Bash", tool_family: "shell", target_kind: "command", target_redacted: "npm test", status: "error", error_class: "tool_error" })] },
      }],
    };
    const checked = validateLocalResultV3(value);
    if (!checked.ok) throw new Error(`fixture is not a valid tma-local-result/3: ${checked.errors.join("; ")}`);
    return checked.value;
  };

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
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'hl-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, name, description, visibility, status) values ($1, 'itera', 'HL test task', 'Synthetic.', 'public', 'ready') returning id`,
      [tag],
    )).rows[0].id;
    await pool.query(`insert into public.task_versions (task_id, version, source, pack_id, pack_version, runnable) values ($1, 1, 'curated', $2, '1', true)`, [taskId, tag]);
    const out = await upload.importResultV2(ALICE, body(), { dryRun: false, perDay: 50, tenant: TENANT });
    runId = out.runIds[0]!;
  });

  afterAll(async () => {
    await pool.query(`delete from public.runs where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.evaluations where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.eval_cases where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.eval_variants where owner_wallet = $1`, [ALICE]);
    await pool.query(`delete from public.grader_versions where tenant = $1`, [TENANT]);
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

  it("returns the redacted steps of the run with tool, target, status and timing, and nothing for another tenant", async () => {
    const steps = await store.steps(runId, TENANT);
    expect(steps.map((x) => x.seq)).toEqual([1, 2]);
    expect(steps[0]).toMatchObject({ tool: "Read", target: "lib/add.js", status: "ok", durationMs: 1000, kind: "read" });
    expect(steps[1]).toMatchObject({ tool: "Bash", target: "npm test", status: "error", errorClass: "tool_error", kind: "test" });
    // The upload is tma-trajectory/1 (no stored kind): the queue boxes carry the derived kind too.
    expect((await store.queue(TENANT, JUDGE, LABELER, 50))[0]!.steps).toEqual([{ seq: 1, kind: "read", ok: true }, { seq: 2, kind: "test", ok: false }]);
    expect(await store.steps(runId, `${TENANT}-other`)).toEqual([]);
  });

  it("is ready after 0024 and names the tenant of the run's case", async () => {
    expect(await store.ready()).toBe(true);
    // caseRuns: the run of the case for its tenant, nothing for another tenant or another key (C6-T2 writer lookup).
    expect((await store.caseRuns(TENANT, `${tag}-review`)).map((r) => r.runId)).toEqual([runId]);
    expect(await store.caseRuns(`${TENANT}-other`, `${tag}-review`)).toEqual([]);
    expect(await store.caseRuns(TENANT, `${tag}-none`)).toEqual([]);
    expect(await store.runTenant(runId)).toEqual({ tenant: TENANT });
    expect(await store.runTenant(randomUUID())).toBeNull();
  });

  it("queues the run with the disagreement and the folded steps, while only a workflow label exists", async () => {
    const q = await store.queue(TENANT, JUDGE, LABELER, 50);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({
      runId, caseKey: `${tag}-review`, useCaseKey: "fix/red-ci", modelId: MODEL, disagree: true,
      judge: { pass: true }, workflow: { pass: false, labeler: "workflow:reverted" }, mine: null,
    });
    expect(q[0]!.steps.map((s) => s.ok)).toEqual([true, false]);
    expect(await store.queue(`${TENANT}-other`, JUDGE, LABELER, 50)).toEqual([]);
  });
  it("writes a label on the human label grader and reads it back", async () => {
    const w = await store.insert({ tenant: TENANT, runId, judgeId: JUDGE, pass: true, reasonCode: "other", labeler: LABELER });
    expect(w).toMatchObject({ runId, judgeId: JUDGE, pass: true, reasonCode: "other", labeler: LABELER });
    const labels = await store.labels(runId, TENANT);
    expect(labels.map((l) => l.labeler).sort()).toEqual([LABELER, "workflow:reverted"].sort());
    expect(labels.find((l) => l.id === w.id)).toMatchObject({ pass: true, reasonCode: "other" });
    // The upload's workflow label and the route's label share ONE human grader version (the kit digest rule).
    const n = Number((await pool.query(
      `select count(*)::int as n from public.grader_versions where tenant = $1 and grader_id = $2 and kind = 'human'`, [TENANT, labelGraderId(JUDGE)],
    )).rows[0].n);
    expect(n).toBe(1);
    expect(await store.labels(runId, `${TENANT}-other`)).toEqual([]);
  });

  it("a person's label under judge A takes the run out of queue A and leaves it in queue B", async () => {
    const OTHER = "external-block-handling";
    const w = await store.insert({ tenant: TENANT, runId, judgeId: JUDGE, pass: true, reasonCode: "other", labeler: LABELER });
    expect(w.judgeId).toBe(JUDGE);
    // Queue A: the run is gone, for the labeler and for any other caller. Queue B: the run is still there.
    expect(await store.queue(TENANT, JUDGE, LABELER, 50)).toEqual([]);
    expect(await store.queue(TENANT, JUDGE, `person:${randomUUID()}`, 50)).toEqual([]);
    const b = await store.queue(TENANT, OTHER, LABELER, 50);
    expect(b.map((r) => r.runId)).toEqual([runId]);
    // A label under B closes B too. The two queues are independent.
    await store.insert({ tenant: TENANT, runId, judgeId: OTHER, pass: false, reasonCode: null, labeler: LABELER });
    expect(await store.queue(TENANT, OTHER, LABELER, 50)).toEqual([]);
  });

});
