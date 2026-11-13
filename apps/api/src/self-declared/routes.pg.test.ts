/**
 * The route endpoints on a real Postgres (plan 20261112-tma-c8-routing-from-evals, C8-T2). Runs when ITERA_PG_TEST_URL
 * points at a THROWAWAY Postgres with db/migrations applied (0026 included). Never point it at a real project. The
 * evidence rows are SYNTHETIC and written through PgSelfDeclaredStore.importResultV2 (the real upload path), in a
 * tenant of their own, so the one-live index never meets another test's rows.
 *
 * Proves: approve goes through the real SQL (PgUseCaseCompareReader + PgRoutesStore) and the row satisfies every
 * eval_routes CHECK, with the frozen verdict, n, evidence, refs and approver; n < 5 is refused by the API (and the DB
 * CHECK would refuse it too); a NOT YET cell and another principal's agent write no row; approved → live → rolled_back
 * through the real UPDATE; a second live route on the same target → 409 live_route_exists, and the one-live index
 * refuses the same UPDATE when the API's pre-check is skipped (23505); GET /routes reads the rows.
 *
 * CI: no step runs this file yet (the step goes in .github/workflows/web3-e2e-guard.yml, a human-merge path).
 */
import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalResultV2 } from "@itera/contracts";
import { validateLocalResultV2, validateRoute } from "@itera/contracts";
import { issueSessionToken } from "../auth/session.js";
import { resetSchemaFeatures } from "../domain/schema-features.js";
import { createRoutesRouter, PgRoutesStore } from "./routes.js";
import { PgSelfDeclaredStore } from "./store.pg.js";
import { agentKeyOf, PgUseCaseCompareReader } from "./use-case-compare.js";

process.env.ITERA_SESSION_SECRET = process.env.ITERA_SESSION_SECRET ?? "test-session-secret";

const URL_ = process.env.ITERA_PG_TEST_URL;
const H = (c: string) => c.repeat(64);
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UC = "fix/prod-bug";

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

describe.skipIf(!URL_)("route endpoints on Postgres (0026 applied)", () => {
  const pool = new Pool({ connectionString: URL_, max: 4 });
  const results = new PgSelfDeclaredStore(pool);
  const routes = new PgRoutesStore(() => pool);
  const reader = new PgUseCaseCompareReader(() => pool);
  const tag = `rt-${randomUUID().slice(0, 8)}`;
  const TENANT = tag;
  const ALICE = `dfl:${randomUUID()}`;
  const BOB = `dfl:${randomUUID()}`;
  const APPLIER = `dfl:${randomUUID()}`;
  const opts = { dryRun: false, perDay: 50, tenant: TENANT };
  const agents: Record<string, string> = {};
  let taskId = "";
  let vendorId = "";
  let server: Server;
  let base = "";

  const AGENT = {
    harness: "opencode", harness_version: "1.18.31", harness_repo_sha: "0".repeat(40), model_id: "opencode-go/deepseek-v4-pro",
    rules_sha256: H("6"), skills_sha256: H("7"), mcp_manifest_sha256: H("8"), tools_sha256: null,
  };
  const run = (repeat: number, lintPass: boolean) => ({
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
      { id: "rt-hidden-tests", semver: "1.0.0", code_sha256: H("9"), kind: "code", pass: true, score: 100, weight: 3, hard_gate: true, decisive: true },
      { id: "rt-lint", semver: "1.0.0", code_sha256: H("5"), kind: "code", pass: lintPass, score: lintPass ? 100 : 0, weight: 1, hard_gate: false, decisive: true },
    ],
  });
  const v2 = (agentId: string, caseKey: string, variant: Record<string, unknown>, runs: unknown[], baseline: boolean): LocalResultV2 => {
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
      case: { case_key: caseKey, manifest_sha256: H("1"), origin_pin_sha256: H("2"), mode: "replay", use_case_key: UC },
      variant,
      comparison: baseline ? { is_baseline: true, prediction_sha256: null } : { is_baseline: false, prediction_sha256: H("4") },
      runs,
    };
    const checked = validateLocalResultV2(value);
    if (!checked.ok) throw new Error(`fixture is not a valid tma-local-result/2: ${checked.errors.join("; ")}`);
    return checked.value;
  };
  const variantOf = (model: string) => ({ agent: { ...AGENT, model_id: model }, variant_sha256: EMPTY, label: "baseline", change_kind: "none" });
  const BASE = variantOf("opencode-go/deepseek-v4-pro");
  const WORSE = variantOf("zai/glm-5.3");
  const SMALL = variantOf("zai/glm-5.3-air");
  const runs = (n: number, lintPass: boolean) => Array.from({ length: n }, (_, i) => run(i + 1, lintPass));
  const keys: Record<string, string> = {};

  const call = async (method: string, path: string, body?: unknown, who: string = ALICE) => {
    const headers: Record<string, string> = { authorization: `Bearer ${issueSessionToken(who, Date.now(), "dfl").token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const approveBody = (over: Record<string, unknown> = {}) => ({
    use_case: UC, agent: keys.base, current_agent: null, picked_rule: "absolute", route_target: "env:DFL_ROUTE_FIX_PROD_BUG",
    target_value: "deepseek", rollback_value: "sonnet", ...over,
  });
  const countRoutes = async () => Number((await pool.query(`select count(*) from public.eval_routes where tenant = $1`, [TENANT])).rows[0].count);

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
    await pool.query(`insert into public.task_packs (id, version, evaluator_ref) values ($1, '1', 'rt-test')`, [tag]);
    taskId = (await pool.query(
      `insert into public.tasks (slug, kind, name, description, visibility, status) values ($1, 'itera', 'Route test task', 'Synthetic.', 'public', 'ready') returning id`,
      [tag],
    )).rows[0].id;
    await pool.query(
      `insert into public.task_versions (task_id, version, source, pack_id, pack_version, runnable) values ($1, 1, 'curated', $2, '1', true)`,
      [taskId, tag],
    );
    // Alice: BASE on two cases (5 + 5 runs, all pass → SAME, n = 10); WORSE on case 1 (lint fails → 75, NOT YET);
    // SMALL on case 1 with 4 runs. Bob: WORSE on case 1.
    await results.importResultV2(ALICE, v2(agents.alice!, `${tag}-c1`, BASE, runs(5, true), true), opts);
    await results.importResultV2(ALICE, v2(agents.alice!, `${tag}-c2`, BASE, runs(5, true), true), opts);
    await results.importResultV2(ALICE, v2(agents.alice!, `${tag}-c1`, WORSE, runs(5, false), false), opts);
    await results.importResultV2(ALICE, v2(agents.alice!, `${tag}-c1`, SMALL, runs(4, true), false), opts);
    await results.importResultV2(BOB, v2(agents.bob!, `${tag}-c1`, WORSE, runs(5, false), true), opts);
    const rows = await reader.rowsOf(UC, ALICE, TENANT);
    for (const [k, model] of [["base", BASE], ["worse", WORSE], ["small", SMALL]] as const) {
      const r = rows.runs.find((x) => x.modelId === model.agent.model_id)!;
      keys[k] = agentKeyOf(r);
    }

    const app = express();
    app.use(express.json());
    app.use(createRoutesRouter({ store: routes, reader, tenant: TENANT, applyActors: [APPLIER] }));
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    // Throwaway database only: the API role has no DELETE on eval_routes; this test connects as the admin.
    await pool.query(`delete from public.eval_routes where tenant = $1`, [TENANT]);
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

  let firstId = "";

  it("approves through the real SQL: the row passes every CHECK and is a valid tma-route/2 row", async () => {
    expect(await routes.ready()).toBe(true);
    const r = await call("POST", "/routes/approve", approveBody({ fallback_agent: keys.small }));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const v = validateRoute(r.json);
    expect(v.ok ? [] : v.errors).toEqual([]);
    expect(r.json).toMatchObject({
      tenant: TENANT, use_case_key: UC, model_id: "opencode-go/deepseek-v4-pro", harness: "opencode", harness_repo_sha: "0".repeat(40),
      rules_sha256: H("6"), skills_sha256: [H("7")], fallback_model_id: "zai/glm-5.3-air", picked_rule: "absolute", verdict: "same", n: 10,
      policy_version: "c8-1", state: "approved", approved_by_actor: ALICE, format: "tma-route/2", live_at: null, rollback_pr_url: null,
      rolled_back_at: null,
    });
    expect(r.json.evidence_run_ids).toHaveLength(10);
    firstId = r.json.id;
    const db = (await pool.query(`select * from public.eval_routes where id = $1`, [firstId])).rows[0];
    expect(db).toMatchObject({ state: "approved", n: 10, verdict: "same", approved_by_actor: ALICE, fallback_harness: "opencode" });
    expect(db.approved_at).toBeInstanceOf(Date);
    // The evidence runs are Alice's runs in this tenant.
    const own = await pool.query(`select count(*) from public.runs where id = any($1::uuid[]) and owner_wallet = $2`, [db.evidence_run_ids, ALICE]);
    expect(Number(own.rows[0].count)).toBe(10);
  });

  it("refuses n = 4 in the API (and the DB CHECK agrees), a NOT YET cell and another principal's agent; no row written", async () => {
    const before = await countRoutes();
    expect((await call("POST", "/routes/approve", approveBody({ agent: keys.small }))).json).toMatchObject({ error: "n_too_small", n: 4 });
    expect((await call("POST", "/routes/approve", approveBody({ agent: keys.worse }))).json).toMatchObject({ error: "verdict_not_passing" });
    expect((await call("POST", "/routes/approve", approveBody(), BOB)).json).toMatchObject({ error: "unknown_agent" });
    expect(await countRoutes()).toBe(before);
    // The same n = 4 row written direct is refused by eval_routes_cited_verdict_check.
    const good = (await pool.query(`select * from public.eval_routes where id = $1`, [firstId])).rows[0];
    const err = await pool
      .query(
        `insert into public.eval_routes (tenant, use_case_key, route_target, target_value, agent_sha256, harness, model_id, picked_rule, verdict,
           n, evidence_run_ids, compare_profile_sha256, policy_version, state, approved_by_actor, approved_at)
         values ($1, $2, $3, 'x', $4, 'opencode', $5, 'absolute', 'same', 4, $6::uuid[], $7, 'c8-1', 'approved', $8, now())`,
        [TENANT, UC, "env:DFL_ROUTE_N4", good.agent_sha256, good.model_id, good.evidence_run_ids, good.compare_profile_sha256, ALICE],
      )
      .catch((e: unknown) => e);
    expect(pgCode(err)).toBe("23514");
  });

  it("approved → live; a second live route on the target → 409; the one-live index refuses it too; live → rolled_back", async () => {
    const pr = (n: number) => `https://github.com/example-org/infra/pull/${n}`;
    const live = await call("PATCH", `/routes/${firstId}/state`, { state: "live", pr_url: pr(1) }, APPLIER);
    expect(live.status, JSON.stringify(live.json)).toBe(200);
    expect(live.json).toMatchObject({ format: "tma-route/2", state: "live", pr_url: pr(1), rollback_pr_url: null, rolled_back_at: null });
    expect(live.json.live_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(validateRoute(live.json).ok).toBe(true);

    const second = (await call("POST", "/routes/approve", approveBody({ target_value: "deepseek-pro" }))).json.id as string;
    const r = await call("PATCH", `/routes/${second}/state`, { state: "live", pr_url: pr(2) }, APPLIER);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "live_route_exists", live_route_id: firstId });
    // Without the API pre-check, the index refuses the same UPDATE.
    const err = await routes.transition(second, TENANT, "approved", "live", pr(2)).catch((e: unknown) => e);
    expect(pgCode(err)).toBe("23505");
    expect((await pool.query(`select state from public.eval_routes where id = $1`, [second])).rows[0].state).toBe("approved");
    // Non-listed principal; wrong transition.
    expect((await call("PATCH", `/routes/${second}/state`, { state: "live", pr_url: pr(2) }, ALICE)).status).toBe(403);
    expect((await call("PATCH", `/routes/${second}/state`, { state: "rolled_back", pr_url: pr(2) }, APPLIER)).json.error).toBe("invalid_transition");

    const back = await call("PATCH", `/routes/${firstId}/state`, { state: "rolled_back", pr_url: pr(3) }, APPLIER);
    expect(back.status).toBe(200);
    expect(back.json).toMatchObject({ state: "rolled_back", pr_url: pr(1), rollback_pr_url: pr(3), live_at: live.json.live_at });
    expect(back.json.rolled_back_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(validateRoute(back.json).ok).toBe(true);
    const db = (await pool.query(`select * from public.eval_routes where id = $1`, [firstId])).rows[0];
    expect(db).toMatchObject({ state: "rolled_back", pr_url: pr(1), rollback_pr_url: pr(3) });
    expect(db.live_at).toBeInstanceOf(Date);
    expect(db.rolled_back_at).toBeInstanceOf(Date);
    // The target is free again.
    expect((await call("PATCH", `/routes/${second}/state`, { state: "live", pr_url: pr(2) }, APPLIER)).status).toBe(200);
  });

  it("GET /routes and GET /routes/:id read the tenant's rows", async () => {
    const all = await call("GET", "/routes");
    expect(all.status).toBe(200);
    expect(all.json.routes).toHaveLength(2);
    for (const row of all.json.routes) expect(validateRoute(row).ok).toBe(true);
    expect((await call("GET", "/routes?state=rolled_back")).json.routes.map((x: any) => x.id)).toEqual([firstId]);
    expect((await call("GET", `/routes?use_case=${encodeURIComponent("fix/other")}`)).json.routes).toEqual([]);
    const one = await call("GET", `/routes/${firstId}`);
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ id: firstId, state: "rolled_back" });
    expect((await call("GET", `/routes/${randomUUID()}`)).status).toBe(404);
  });
});
