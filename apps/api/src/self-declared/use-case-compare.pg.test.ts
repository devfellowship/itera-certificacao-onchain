/**
 * PgUseCaseCompareReader against a real Postgres (plan 20261112-tma-c7-model-comparison-per-use-case, C7-T3). Runs
 * when ITERA_PG_TEST_URL points at a THROWAWAY Postgres with db/migrations applied (the web3 e2e guard job sets it).
 * Never point it at a real project. Rows are written through PgSelfDeclaredStore.importResultV2 (the real upload path).
 *
 * Proves: the reader returns the runs of every case of the use case for the owner in the tenant, with the variant's
 * agent_sha256, model and harness, the metered cost and wall time; only the LATEST grading row per (run, grader
 * version) after a re-grade; a run of another principal, of another tenant or of another use case is not returned;
 * and the view over those rows has the expected agent, n and verdicts.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalResultV2 } from "@itera/contracts";
import { validateLocalResultV2 } from "@itera/contracts";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { PgSelfDeclaredStore } from "./store.pg.js";
import { agentKeyOf, compareView, PgUseCaseCompareReader } from "./use-case-compare.js";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UC = "fix/prod-bug";

describe.skipIf(!URL_)("PgUseCaseCompareReader on Postgres (0023 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const store = new PgSelfDeclaredStore(pool);
  const reader = new PgUseCaseCompareReader(() => pool);
  const tag = `ucc-${randomUUID().slice(0, 8)}`;
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  const TENANT = "devfellowship";
  const opts = { dryRun: false, perDay: 50, tenant: TENANT };
  const agents: Record<string, string> = {};
  let taskId = "";
  let vendorId = "";

  const AGENT = {
    harness: "opencode", harness_version: "1.18.31", harness_repo_sha: "0".repeat(40), model_id: "opencode-go/deepseek-v4-pro",
    rules_sha256: H("6"), skills_sha256: H("7"), mcp_manifest_sha256: H("8"), tools_sha256: null,
  };
  const run = (repeat: number, lintPass: boolean, over: Record<string, unknown> = {}) => ({
    item_sha256: H("a"), repeat, status: lintPass ? "pass" : "fail", score: lintPass ? 100 : 75, wall_s: 2, cost_usd: 0.031,
    tokens_in: 100, tokens_out: 10, error_class: null,
    parts: { public_behavior: 20, hidden_behavior: 50, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
    infra_ok: true,
    trajectory: {
      format: "tma-trajectory/1",
      steps: [{
        seq: 1, parent_seq: null, turn: 1, tool: "Edit", tool_family: "builtin", status: "ok", error_class: null, duration_ms: 120,
        tokens_in: 90, tokens_out: 8, target_kind: "file", target_redacted: "src/a.ts", args_sha256: H("b"), result_sha256: H("c"), retry_of: null,
      }],
    },
    graders: [
      { id: "ucc-hidden-tests", semver: "1.0.0", code_sha256: H("9"), kind: "code", pass: true, score: 100, weight: 3, hard_gate: true, decisive: true },
      { id: "ucc-lint", semver: "1.0.0", code_sha256: H("5"), kind: "code", pass: lintPass, score: lintPass ? 100 : 0, weight: 1, hard_gate: false, decisive: true },
    ],
    ...over,
  });
  const v2 = (agentId: string, caseKey: string, useCase: string, variant: Record<string, unknown>, runs: unknown[], baseline: boolean): LocalResultV2 => {
    const value: Record<string, unknown> = {
      format: "tma-local-result/2",
      agent_id: agentId,
      task: { catalog: { slug: tag, version: 1 } },
      metrics_shape: "tma-score/1",
      grader_version: "1.1.0",
      runner: { version: "0.1.0", execution: "tma-sandbox", profile: "opencode", sandbox_image_id: `sha256:${H("d")}` },
      executor: { model_id: (variant.agent as { model_id: string }).model_id, provider: "deepseek", route: "opencode-go", harness: "opencode 1.18.31", variant: null, cost_source: "metered" },
      ran_from: "2026-11-12T12:00:00Z",
      ran_to: "2026-11-12T12:20:00Z",
      summary: { score: 90, runs: runs.length, items: 1 },
      case: { case_key: caseKey, manifest_sha256: H("1"), origin_pin_sha256: H("2"), mode: "replay", use_case_key: useCase },
      variant,
      comparison: baseline ? { is_baseline: true, prediction_sha256: null } : { is_baseline: false, prediction_sha256: H("4") },
      runs,
    };
    const checked = validateLocalResultV2(value);
    if (!checked.ok) throw new Error(`fixture is not a valid tma-local-result/2: ${checked.errors.join("; ")}`);
    return checked.value;
  };
  const BASE = { agent: AGENT, variant_sha256: EMPTY, label: "baseline", change_kind: "none" };
  const OTHER_MODEL = { agent: { ...AGENT, model_id: "zai/glm-5.3" }, variant_sha256: EMPTY, label: "baseline", change_kind: "none" };
  const five = (lintPass: boolean) => [1, 2, 3, 4, 5].map((i) => run(i, lintPass));

  beforeAll(async () => {
    resetSchemaFeatures();
    vendorId = (await pool.query(`insert into public.vendors (display_name) values ($1) returning id`, [tag])).rows[0].id;
    for (const [who, wallet] of [["alice", ALICE], ["bob", BOB]] as const) {
      agents[who] = (await pool.query(
        `insert into public.agents (vendor_id, name, endpoint_url, owner_wallet, model, connector, visibility, status)
         values ($1, $2, $3, $4, 'zai/glm-5.3', 'endpoint', 'private', 'active') returning id`,
        [vendorId, `${tag} ${who}`, `https://${tag}-${who}.example`, wallet],
      )).rows[0].id;
      await pool.query(`insert into public.agent_versions (agent_id, commit_sha, files) values ($1, $2, '[]'::jsonb)`, [agents[who], "c".repeat(40)]);
    }
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'ucc-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, name, description, visibility, status) values ($1, 'itera', 'UCC test task', 'Synthetic.', 'public', 'ready') returning id`,
      [tag],
    )).rows[0].id;
    await pool.query(
      `insert into public.task_versions (task_id, version, source, pack_id, pack_version, runnable) values ($1, 1, 'curated', $2, '1', true)`,
      [taskId, tag],
    );
  });

  afterAll(async () => {
    for (const w of [ALICE, BOB]) {
      await pool.query(`delete from public.runs where owner_wallet = $1`, [w]);
      await pool.query(`delete from public.evaluations where owner_wallet = $1`, [w]);
      await pool.query(`delete from public.eval_cases where owner_wallet = $1`, [w]);
      await pool.query(`delete from public.eval_variants where owner_wallet = $1`, [w]);
    }
    await pool.query(
      `delete from public.grader_versions gv where gv.code_sha256 = any($1::text[]) and not exists (select 1 from public.grader_results gr where gr.grader_version_id = gv.id)`,
      [[H("9"), H("5")]],
    );
    await pool.query(`delete from public.release_declarations where agent_id = any($1::uuid[])`, [Object.values(agents)]);
    await pool.query(`delete from public.task_versions where task_id = $1`, [taskId]);
    await pool.query(`delete from public.tasks where id = $1`, [taskId]);
    await pool.query(`delete from public.task_packs where id = $1`, [tag]);
    await pool.query(`delete from public.agent_versions where agent_id = any($1::uuid[])`, [Object.values(agents)]);
    await pool.query(`delete from public.agents where id = any($1::uuid[])`, [Object.values(agents)]);
    await pool.query(`delete from public.vendors where id = $1`, [vendorId]);
    await pool.end();
  });

  it("reads the owner's runs of the use case in the tenant, latest grading per grader version", async () => {
    expect(await reader.ready()).toBe(true);
    // Alice: agent 1 on two cases (5 runs each, all pass), agent 2 (another model) on case 1 (lint fails).
    const a1 = await store.importResultV2(ALICE, v2(agents.alice!, `${tag}-c1`, UC, BASE, five(true), true), opts);
    await store.importResultV2(ALICE, v2(agents.alice!, `${tag}-c2`, UC, BASE, five(true), true), opts);
    const a2 = await store.importResultV2(ALICE, v2(agents.alice!, `${tag}-c1`, UC, OTHER_MODEL, five(false), false), opts);
    // A re-grade of agent 2's run 1: lint now passes. The latest row must count.
    await store.importResultV2(
      ALICE, v2(agents.alice!, `${tag}-c1`, UC, OTHER_MODEL, [run(1, true), ...five(false).slice(1)], false), opts,
    );
    // Noise that must not count: Bob on the same use case, Alice in another tenant, Alice on another use case.
    await store.importResultV2(BOB, v2(agents.bob!, `${tag}-c1`, UC, BASE, five(false), true), opts);
    await store.importResultV2(ALICE, v2(agents.alice!, `${tag}-t2`, UC, BASE, five(false), true), { ...opts, tenant: "other-tenant" });
    await store.importResultV2(ALICE, v2(agents.alice!, `${tag}-u2`, "fix/other", BASE, five(false), true), opts);

    const rows = await reader.rowsOf(UC, ALICE, TENANT);
    expect(rows.runs).toHaveLength(15);
    expect(new Set(rows.runs.map((r) => r.variantId))).toEqual(new Set([a1.variantId, a2.variantId]));
    expect(rows.runs.every((r) => r.harness === "opencode" && r.costUsd === 0.031 && r.costSource === "metered" && r.wallMs === 2000 && r.infraOk === true)).toBe(true);
    // One row per (run, grader version): 15 runs x 2 graders, re-grade included.
    expect(rows.graders).toHaveLength(30);
    const run1 = rows.runs.find((r) => r.variantId === a2.variantId && rows.graders.some((g) => g.runId === r.runId && g.graderId === "ucc-lint" && g.pass));
    expect(run1).toBeDefined();
    expect(rows.graders.filter((g) => g.graderId === "ucc-lint" && g.pass)).toHaveLength(11);
    expect(rows.graders.find((g) => g.graderId === "ucc-hidden-tests")).toMatchObject({ semver: "1.0.0", kind: "code", weight: 3, hardGate: true, decisive: true });

    const view = compareView(UC, rows, agentKeyOf(rows.runs.find((r) => r.variantId === a2.variantId)!));
    expect(view.agents).toHaveLength(2);
    const one = view.agents.find((a) => a.variant_ids[0] === a1.variantId)!;
    const two = view.agents.find((a) => a.variant_ids[0] === a2.variantId)!;
    expect(one).toMatchObject({ model_id: "opencode-go/deepseek-v4-pro", n: 10, mean_score: 100, cost_label: "metered", absolute: { label: "SAME" } });
    expect(two).toMatchObject({ model_id: "zai/glm-5.3", n: 5, mean_score: 80, relative: { label: "refused", reason: "is_current_agent" } });
    expect(one.relative).toMatchObject({ label: "better", gap: 20 });

    expect((await reader.rowsOf(UC, BOB, TENANT)).runs).toHaveLength(5);
    expect((await reader.rowsOf("fix/none", ALICE, TENANT)).runs).toHaveLength(0);
  });
});
