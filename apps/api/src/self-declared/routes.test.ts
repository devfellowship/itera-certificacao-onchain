/**
 * The route endpoints over a fake compare reader and an in-memory route store (plan 20261112-tma-c8-routing-from-evals,
 * C8-T2). The fake reader filters by owner, tenant and use case as PgUseCaseCompareReader does; every verdict comes
 * from @itera/contracts/compare (through compareView). Every answered row is checked with validateRoute (tma-route/2).
 *
 * Proves: approve with n = 4 → 400 n_too_small; a NOT YET cell (absolute) and a worse cell (relative) → 400
 * verdict_not_passing; another principal's or tenant's agent → 400 unknown_agent, refs the caller does not own → 403,
 * and no row is written in each case; an unknown key or a free-text value → 400; a good approve → 201 with the frozen
 * verdict, n, evidence, refs and approver; PATCH only for TMA_ROUTE_APPLY_ACTORS (unset → 403); approved → live and
 * live → rolled_back → 200; approved → rolled_back → 409; a second live route on the same target → 409 with the live id
 * (the other row unchanged); GET filters and query refusals; 503 before 0026.
 * T5 (needs_check, ADR-7): live → needs_check with a body of exactly {state} keeps pr_url and live_at; needs_check →
 * rolled_back; every other pair into or out of needs_check → 409; a needs_check row blocks approved → live on its target
 * like a live row (409 live_route_exists naming it); a pr_url in the needs_check body → 400; not an apply actor → 403.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRoute } from "@itera/contracts";
import { issueSessionToken } from "../auth/session.js";
import {
  applyActorsFromEnv, compareProfileSha256, createRoutesRouter, parseApproveBody, type NewApprovedRoute, type PatchTarget, type RouteFilter, type RouteRecord,
  type RoutesStore, type VariantRef,
} from "./routes.js";
import {
  agentKeyOf, compareView, type CompareGraderRow, type CompareRunRow, type UseCaseCompareReader, type UseCaseRows,
} from "./use-case-compare.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const BOB = "dfl:00000000-0000-4000-8000-00000000000b";
const APPLIER = "dfl:00000000-0000-4000-8000-0000000000ff";
const WALLET = "So11111111111111111111111111111111111111112";
const TENANT = "devfellowship";
const UC = "fix/prod-bug";
const UC2 = "content/report-html";
const dfl = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;
const H = (c: string) => c.repeat(64);
const uuid = (n: number, tag = "a") => `${tag.repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Row { run: CompareRunRow; graders: CompareGraderRow[]; owner: string; tenant: string; useCase: string }

class FakeReader implements UseCaseCompareReader {
  rows: Row[] = [];
  async ready() {
    return true;
  }
  async rowsOf(useCaseKey: string, owner: string, tenant: string): Promise<UseCaseRows> {
    const mine = this.rows.filter((r) => r.owner === owner && r.tenant === tenant && r.useCase === useCaseKey);
    return { runs: mine.map((r) => r.run), graders: mine.flatMap((r) => r.graders) };
  }
}

class FakeStore implements RoutesStore {
  isReady = true;
  rows: RouteRecord[] = [];
  refs: (VariantRef & { owner: string; tenant: string })[] = [];
  async ready() {
    return this.isReady;
  }
  async variantRefs(ids: string[], owner: string, tenant: string) {
    return this.refs.filter((r) => ids.includes(r.variantId) && r.owner === owner && r.tenant === tenant);
  }
  async insertApproved(r: NewApprovedRoute) {
    const now = new Date();
    const row: RouteRecord = {
      ...r, id: randomUUID(), state: "approved", pr_url: null, rollback_pr_url: null, created_at: now, approved_at: now, live_at: null,
      rolled_back_at: null, updated_at: now,
    };
    this.rows.push(row);
    return row;
  }
  async get(id: string, tenant: string) {
    return this.rows.find((r) => r.id === id && r.tenant === tenant) ?? null;
  }
  async list(tenant: string, f: RouteFilter, limit: number) {
    return this.rows
      .filter((r) => r.tenant === tenant && (!f.useCase || r.use_case_key === f.useCase) && (!f.state || r.state === f.state))
      .reverse()
      .slice(0, limit);
  }
  async appliedOnTarget(tenant: string, target: string, exceptId: string) {
    const r = this.rows.find(
      (x) => x.tenant === tenant && x.route_target === target && (x.state === "live" || x.state === "needs_check") && x.id !== exceptId,
    );
    return r ? { id: r.id, state: r.state as "live" | "needs_check" } : null;
  }
  async transition(id: string, tenant: string, from: string, to: PatchTarget, prUrl: string | null) {
    const r = this.rows.find((x) => x.id === id && x.tenant === tenant && x.state === from);
    if (!r) return null;
    const now = new Date();
    if (to === "live") Object.assign(r, { state: "live", pr_url: prUrl, live_at: now, updated_at: now });
    else if (to === "needs_check") Object.assign(r, { state: "needs_check", updated_at: now });
    else Object.assign(r, { state: "rolled_back", rollback_pr_url: prUrl, rolled_back_at: now, updated_at: now });
    return r;
  }
}

interface AgentSpec { sha: string; model: string; variant: string; lintPass: boolean }
const A: AgentSpec = { sha: H("1"), model: "anthropic/claude-sonnet-5-5", variant: uuid(1), lintPass: true };
const B: AgentSpec = { sha: H("2"), model: "zai/glm-5.3", variant: uuid(2), lintPass: false };
const D: AgentSpec = { sha: H("4"), model: "opencode-go/deepseek-v4-pro", variant: uuid(4), lintPass: true };
const E: AgentSpec = { sha: H("5"), model: "zai/glm-5.3-air", variant: uuid(5), lintPass: true };
const keyOf = (s: AgentSpec) => agentKeyOf({ agentSha256: s.sha, modelId: s.model });

let seq = 0;
function row(s: AgentSpec, caseKey: string, over: Partial<Row> = {}): Row {
  const runId = uuid(++seq, "b");
  const g = (graderId: string, pass: boolean, weight: number, hardGate: boolean): CompareGraderRow => ({
    runId, graderId, semver: "1.0.0", kind: "code", pass, weight, hardGate, decisive: true,
  });
  return {
    run: {
      runId, caseKey, variantId: s.variant, agentSha256: s.sha, modelId: s.model, harness: "opencode", infraOk: true, costUsd: 0.02,
      costSource: "metered", wallMs: 1000,
    },
    graders: [g("hidden-tests", true, 3, true), g("lint", s.lintPass, 1, false)],
    owner: ALICE,
    tenant: TENANT,
    useCase: UC,
    ...over,
  };
}
const runsOf = (s: AgentSpec, n: number, over: Partial<Row> = {}) => Array.from({ length: n }, (_, i) => row(s, `case-${i % 2}`, over));
const refOf = (s: AgentSpec, over: Partial<VariantRef & { owner: string; tenant: string }> = {}) => ({
  variantId: s.variant, agentSha256: s.sha, harness: "opencode", harnessRepoSha: "0".repeat(40), modelId: s.model, rulesSha256: H("6"),
  skillsSha256: H("7"), owner: ALICE, tenant: TENANT, ...over,
});

let server: Server;
let base = "";
let reader: FakeReader;
let store: FakeStore;

async function start(applyActors: string[] = [APPLIER]) {
  const app = express();
  app.use(express.json());
  app.use(createRoutesRouter({ store, reader, tenant: TENANT, applyActors }));
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  reader = new FakeReader();
  // A, B: 10 runs each (A scores 100, B 75). D: 4 runs. E: 10 runs, but only in another tenant. Bob owns 10 runs of B.
  reader.rows = [
    ...runsOf(A, 10), ...runsOf(B, 10), ...runsOf(D, 4), ...runsOf(E, 10, { tenant: "other-tenant" }), ...runsOf(B, 10, { owner: BOB }),
  ];
  store = new FakeStore();
  store.refs = [refOf(A), refOf(B), refOf(D), refOf(E, { tenant: "other-tenant" }), refOf(B, { owner: BOB })];
  await start();
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const call = async (method: string, path: string, body?: unknown, token: string | null = dfl(ALICE)) => {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as any };
};
const goodBody = (over: Record<string, unknown> = {}) => ({
  use_case: UC, agent: keyOf(A), current_agent: null, picked_rule: "absolute", route_target: "env:DFL_ROUTE_FIX_PROD_BUG",
  target_value: "sonnet", rollback_value: "deepseek", ...over,
});
const approve = (over: Record<string, unknown> = {}, token?: string | null) => call("POST", "/routes/approve", goodBody(over), token);
const mark = (id: string, state: string, n = 101, token = dfl(APPLIER)) =>
  call("PATCH", `/routes/${id}/state`, { state, pr_url: `https://github.com/example-org/infra/pull/${n}` }, token);
const markCheck = (id: string, token = dfl(APPLIER)) => call("PATCH", `/routes/${id}/state`, { state: "needs_check" }, token);
const expectValid = (row: unknown) => {
  const v = validateRoute(row);
  expect(v.ok ? [] : v.errors).toEqual([]);
};

describe("POST /routes/approve", () => {
  it("approves a SAME cell (absolute): 201, the frozen verdict, a valid tma-route/2 row", async () => {
    const r = await approve({ fallback_agent: keyOf(D) });
    expect(r.status).toBe(201);
    expectValid(r.json);
    expect(r.json).toMatchObject({
      tenant: TENANT, use_case_key: UC, route_target: "env:DFL_ROUTE_FIX_PROD_BUG", target_value: "sonnet", rollback_value: "deepseek",
      model_id: A.model, agent_sha256: A.sha, harness: "opencode", harness_repo_sha: "0".repeat(40), rules_sha256: H("6"),
      skills_sha256: [H("7")], fallback_model_id: D.model, fallback_agent_sha256: D.sha, picked_rule: "absolute", verdict: "same", n: 10,
      policy_version: "c8-1", state: "approved", pr_url: null, approved_by_actor: ALICE,
      format: "tma-route/2", live_at: null, rollback_pr_url: null, rolled_back_at: null,
    });
    expect(r.json.compare_profile_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The evidence: exactly A's ten runs.
    const aRuns = reader.rows.filter((x) => x.owner === ALICE && x.tenant === TENANT && x.run.agentSha256 === A.sha).map((x) => x.run.runId);
    expect([...r.json.evidence_run_ids].sort()).toEqual(aRuns.sort());
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.fallback_harness).toBe("opencode");
  });

  it("approves a better cell (relative): the evidence cites both sides", async () => {
    const r = await approve({ picked_rule: "relative", current_agent: keyOf(B), policy_version: "c8-2" });
    expect(r.status).toBe(201);
    expectValid(r.json);
    expect(r.json).toMatchObject({ picked_rule: "relative", verdict: "better", n: 10, policy_version: "c8-2" });
    expect(r.json.evidence_run_ids).toHaveLength(20);
  });

  it("freezes exactly the evidence_run_ids that the compare response lists (one helper, Q4 = A)", async () => {
    // An infra-fault run and a no-score run of A: neither is counted, neither is frozen.
    const infra = row(A, "case-0");
    infra.run.infraOk = false;
    const noScore = row(A, "case-1");
    noScore.graders = [];
    reader.rows.push(infra, noScore);
    const rows = await reader.rowsOf(UC, ALICE, TENANT);
    const view = compareView(UC, rows, keyOf(B));
    const ids = (s: AgentSpec) => view.agents.find((a) => a.agent_key === keyOf(s))!.evidence_run_ids;
    const abs = await approve();
    expect(abs.status).toBe(201);
    expect(abs.json.evidence_run_ids).toEqual(ids(A));
    expect(abs.json.evidence_run_ids).not.toContain(infra.run.runId);
    expect(abs.json.evidence_run_ids).not.toContain(noScore.run.runId);
    const rel = await approve({ picked_rule: "relative", current_agent: keyOf(B) });
    expect(rel.status).toBe(201);
    expect(rel.json.evidence_run_ids).toEqual([...ids(A), ...ids(B)]);
  });

  it("refuses n = 4 → 400 n_too_small, nothing written", async () => {
    const r = await approve({ agent: keyOf(D) });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "n_too_small", n: 4 });
    expect(store.rows).toHaveLength(0);
  });

  it("refuses a NOT YET cell under the absolute rule → 400 verdict_not_passing", async () => {
    const r = await approve({ agent: keyOf(B) });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "verdict_not_passing", verdict: "NOT YET" });
    expect(store.rows).toHaveLength(0);
  });

  it("refuses a worse cell under the relative rule → 400 verdict_not_passing", async () => {
    const r = await approve({ agent: keyOf(B), current_agent: keyOf(A), picked_rule: "relative" });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "verdict_not_passing", verdict: "worse" });
    expect(store.rows).toHaveLength(0);
  });

  it("refuses the relative rule with no current agent (the library refuses the rule)", async () => {
    const r = await approve({ picked_rule: "relative" });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "verdict_not_passing", verdict: "refused" });
  });

  it("refuses another principal's or another tenant's agent, and refs the caller does not own; writes no row", async () => {
    // Bob has his own B runs, but not A: A is not an agent of his comparison.
    expect((await approve({}, dfl(BOB))).json).toMatchObject({ error: "unknown_agent" });
    // E exists only in another tenant.
    expect((await approve({ agent: keyOf(E) })).json).toMatchObject({ error: "unknown_agent" });
    expect((await approve({ current_agent: keyOf(E) })).json).toMatchObject({ error: "unknown_current_agent" });
    expect((await approve({ fallback_agent: keyOf(E) })).json).toMatchObject({ error: "unknown_fallback_agent" });
    // A variant row that is not the caller's in this tenant: 403.
    store.refs = store.refs.filter((x) => x.variantId !== A.variant || x.owner !== ALICE);
    const r = await approve();
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("forbidden");
    expect(store.rows).toHaveLength(0);
  });

  it("refuses an unknown key, a free-text value, a missing key, a bad pattern → 400 invalid_body", async () => {
    for (const body of [
      { ...goodBody(), note: "looks good" },
      goodBody({ target_value: "use the sonnet model" }),
      goodBody({ rollback_value: "Deep Seek" }),
      goodBody({ route_target: "env:lower" }),
      goodBody({ picked_rule: "both" }),
      goodBody({ policy_version: "v 1" }),
      goodBody({ agent: "anthropic/claude-sonnet-5-5" }),
      goodBody({ use_case: "fix" }),
      goodBody({ target_value: 5 }),
      (({ current_agent: _c, ...rest }) => rest)(goodBody()),
      [goodBody()],
    ]) {
      const r = await call("POST", "/routes/approve", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toBe("invalid_body");
    }
    expect(store.rows).toHaveLength(0);
  });

  it("refuses a login whose id is not an actor key (a wallet) → 403; no session → 401; 503 before 0026", async () => {
    const w = await approve({}, issueSessionToken(WALLET, Date.now(), "siws").token);
    expect(w.status).toBe(403);
    expect(w.json.error).toBe("approver_not_supported");
    expect((await approve({}, null)).status).toBe(401);
    store.isReady = false;
    const r = await approve();
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("schema_not_ready");
    expect(store.rows).toHaveLength(0);
  });
});

describe("PATCH /routes/:id/state", () => {
  const approved = async (over: Record<string, unknown> = {}) => (await approve(over)).json.id as string;

  it("refuses a principal not in TMA_ROUTE_APPLY_ACTORS → 403, and everybody when it is unset", async () => {
    const id = await approved();
    const r = await mark(id, "live", 101, dfl(ALICE));
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("not_an_apply_actor");
    await new Promise<void>((res) => server.close(() => res()));
    await start(applyActorsFromEnv({}));
    expect((await mark(id, "live")).status).toBe(403);
    expect(store.rows[0]!.state).toBe("approved");
    expect(applyActorsFromEnv({ TMA_ROUTE_APPLY_ACTORS: ` ${APPLIER}, dfl:x ,` })).toEqual([APPLIER, "dfl:x"]);
  });

  it("approved → live → rolled_back: 200 each, a valid row, the PR URLs stored", async () => {
    const id = await approved();
    const live = await mark(id, "live", 101);
    expect(live.status).toBe(200);
    expectValid(live.json);
    expect(live.json).toMatchObject({
      id, format: "tma-route/2", state: "live", pr_url: "https://github.com/example-org/infra/pull/101", rollback_pr_url: null, rolled_back_at: null,
    });
    expect(store.rows[0]!.live_at).not.toBeNull();
    expect(live.json.live_at).toBe((store.rows[0]!.live_at as Date).toISOString());
    const back = await mark(id, "rolled_back", 102);
    expect(back.status).toBe(200);
    expectValid(back.json);
    expect(back.json).toMatchObject({ state: "rolled_back", pr_url: "https://github.com/example-org/infra/pull/101" });
    expect(store.rows[0]).toMatchObject({ rollback_pr_url: "https://github.com/example-org/infra/pull/102" });
    expect(store.rows[0]!.rolled_back_at).not.toBeNull();
    expect(back.json).toMatchObject({ rollback_pr_url: "https://github.com/example-org/infra/pull/102", live_at: live.json.live_at });
    expect(back.json.rolled_back_at).toBe((store.rows[0]!.rolled_back_at as Date).toISOString());
    // The same row through GET answers the same v2 keys.
    expect((await call("GET", `/routes/${id}`)).json).toMatchObject({ format: "tma-route/2", rollback_pr_url: back.json.rollback_pr_url, rolled_back_at: back.json.rolled_back_at });
    // rolled_back is final.
    expect((await mark(id, "live", 103)).json).toMatchObject({ error: "invalid_transition", state: "rolled_back" });
  });

  it("refuses approved → rolled_back, and any other target state → 409 invalid_transition", async () => {
    const id = await approved();
    // needs_check (body exactly {state}) is covered in the needs_check block below.
    for (const s of ["rolled_back", "approved", "proposed"]) {
      const r = await mark(id, s);
      expect(r.status, s).toBe(409);
      expect(r.json.error).toBe("invalid_transition");
    }
    expect(store.rows[0]!.state).toBe("approved");
  });

  it("refuses a second live route on the same target → 409 live_route_exists; the live row is unchanged", async () => {
    const first = await approved();
    const second = await approved({ target_value: "opus" });
    expect((await mark(first, "live", 101)).status).toBe(200);
    const r = await mark(second, "live", 102);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "live_route_exists", live_route_id: first });
    expect(store.rows.find((x) => x.id === first)).toMatchObject({ state: "live", pr_url: "https://github.com/example-org/infra/pull/101" });
    expect(store.rows.find((x) => x.id === second)!.state).toBe("approved");
    // Another target is free.
    const other = await approved({ route_target: "claude-md:fix-prod-bug" });
    expect((await mark(other, "live", 103)).status).toBe(200);
  });

  it("maps a lost race on the one-live index (23505) to 409 live_route_exists", async () => {
    const first = await approved();
    const second = await approved();
    store.transition = async () => {
      // Another request marks `first` live between the pre-check and the update.
      Object.assign(store.rows.find((x) => x.id === first)!, { state: "live", pr_url: "https://github.com/example-org/infra/pull/9", live_at: new Date() });
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    };
    const r = await mark(second, "live");
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "live_route_exists", live_route_id: first });
  });

  it("refuses a bad body, a bad id, a bad PR URL → 400; a route of another tenant → 404", async () => {
    const id = await approved();
    const t = dfl(APPLIER);
    expect((await call("PATCH", `/routes/${id}/state`, { state: "live" }, t)).json.error).toBe("invalid_body");
    expect((await call("PATCH", `/routes/${id}/state`, { state: "live", pr_url: "https://github.com/o/r/pull/1", note: "x" }, t)).json.error).toBe("invalid_body");
    expect((await call("PATCH", `/routes/${id}/state`, { state: "live", pr_url: "https://gitlab.com/o/r/pull/1" }, t)).json.error).toBe("invalid_body");
    expect((await call("PATCH", `/routes/${id}/state`, { state: "done", pr_url: "https://github.com/o/r/pull/1" }, t)).json.error).toBe("invalid_body");
    expect((await call("PATCH", `/routes/not-a-uuid/state`, { state: "live", pr_url: "https://github.com/o/r/pull/1" }, t)).json.error).toBe("invalid_id");
    store.rows[0]!.tenant = "other-tenant";
    expect((await mark(id, "live")).status).toBe(404);
    expect(store.rows[0]!.state).toBe("approved");
  });
});

describe("PATCH /routes/:id/state: needs_check (T5, ADR-7)", () => {
  const approved = async (over: Record<string, unknown> = {}) => (await approve(over)).json.id as string;
  const liveRoute = async (over: Record<string, unknown> = {}, n = 101) => {
    const id = await approved(over);
    expect((await mark(id, "live", n)).status).toBe(200);
    return id;
  };

  it("live → needs_check: 200, a valid tma-route/2 row, pr_url and live_at kept", async () => {
    const id = await liveRoute();
    const before = { ...store.rows[0]! };
    const r = await markCheck(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expectValid(r.json);
    expect(r.json).toMatchObject({
      id, format: "tma-route/2", state: "needs_check", pr_url: "https://github.com/example-org/infra/pull/101",
      live_at: (before.live_at as Date).toISOString(), rollback_pr_url: null, rolled_back_at: null,
    });
    expect(store.rows[0]).toMatchObject({ state: "needs_check", pr_url: before.pr_url, live_at: before.live_at, rollback_pr_url: null });
  });

  it("refuses a pr_url (or any other key) in the needs_check body → 400 invalid_body; the row stays live", async () => {
    const id = await liveRoute();
    const t = dfl(APPLIER);
    for (const body of [
      { state: "needs_check", pr_url: "https://github.com/example-org/infra/pull/7" },
      { state: "needs_check", pr_url: null },
      { state: "needs_check", reason: "drift" },
    ]) {
      const r = await call("PATCH", `/routes/${id}/state`, body, t);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toBe("invalid_body");
    }
    // live and rolled_back still need exactly {state, pr_url}.
    expect((await call("PATCH", `/routes/${id}/state`, { state: "rolled_back" }, t)).json.error).toBe("invalid_body");
    expect(store.rows[0]!.state).toBe("live");
  });

  it("refuses approved → needs_check and rolled_back → needs_check → 409 invalid_transition", async () => {
    const id = await approved();
    const a = await markCheck(id);
    expect(a.status).toBe(409);
    expect(a.json).toMatchObject({ error: "invalid_transition", state: "approved" });
    expect((await mark(id, "live", 101)).status).toBe(200);
    expect((await mark(id, "rolled_back", 102)).status).toBe(200);
    const b = await markCheck(id);
    expect(b.status).toBe(409);
    expect(b.json).toMatchObject({ error: "invalid_transition", state: "rolled_back" });
    // needs_check → needs_check is refused too.
    const other = await liveRoute({ route_target: "claude-md:fix-prod-bug" }, 103);
    expect((await markCheck(other)).status).toBe(200);
    expect((await markCheck(other)).json).toMatchObject({ error: "invalid_transition", state: "needs_check" });
  });

  it("needs_check → rolled_back: 200 with rollback_pr_url and rolled_back_at; pr_url and live_at kept", async () => {
    const id = await liveRoute();
    const liveAt = (store.rows[0]!.live_at as Date).toISOString();
    expect((await markCheck(id)).status).toBe(200);
    const back = await mark(id, "rolled_back", 102);
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    expectValid(back.json);
    expect(back.json).toMatchObject({
      state: "rolled_back", pr_url: "https://github.com/example-org/infra/pull/101", live_at: liveAt,
      rollback_pr_url: "https://github.com/example-org/infra/pull/102",
    });
    expect(back.json.rolled_back_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses needs_check → live → 409 invalid_transition", async () => {
    const id = await liveRoute();
    expect((await markCheck(id)).status).toBe(200);
    const r = await mark(id, "live", 104);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "invalid_transition", state: "needs_check" });
    expect(store.rows[0]).toMatchObject({ state: "needs_check", pr_url: "https://github.com/example-org/infra/pull/101" });
  });

  it("approved → live while another route on the target is needs_check → 409 live_route_exists naming that row", async () => {
    const first = await liveRoute();
    expect((await markCheck(first)).status).toBe(200);
    const second = await approved({ target_value: "opus" });
    const r = await mark(second, "live", 105);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "live_route_exists", live_route_id: first, live_route_state: "needs_check" });
    expect(r.json.message).toContain("needs_check");
    expect(store.rows.find((x) => x.id === first)!.state).toBe("needs_check");
    expect(store.rows.find((x) => x.id === second)!.state).toBe("approved");
    // Once the marked route is rolled back, the target is free.
    expect((await mark(first, "rolled_back", 106)).status).toBe(200);
    expect((await mark(second, "live", 105)).status).toBe(200);
  });

  it("refuses needs_check from a principal not in TMA_ROUTE_APPLY_ACTORS → 403, and everybody when it is unset", async () => {
    const id = await liveRoute();
    const r = await markCheck(id, dfl(ALICE));
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("not_an_apply_actor");
    await new Promise<void>((res) => server.close(() => res()));
    await start([]);
    expect((await markCheck(id)).status).toBe(403);
    expect(store.rows[0]!.state).toBe("live");
  });
});

describe("GET /routes and GET /routes/:id", () => {
  it("lists the tenant's routes newest first, filters by use_case and state, refuses other query keys", async () => {
    const a = (await approve()).json.id;
    const b = (await approve({ route_target: "claude-md:fix-prod-bug" })).json.id;
    // A route of another use case and one of another tenant.
    reader.rows.push(...runsOf(A, 10, { useCase: UC2 }));
    const c = (await approve({ use_case: UC2 })).json.id;
    store.rows.push({ ...store.rows[0]!, id: randomUUID(), tenant: "other-tenant" });
    expect((await mark(b, "live")).status).toBe(200);

    const all = await call("GET", "/routes");
    expect(all.status).toBe(200);
    expect(all.json.routes.map((r: any) => r.id)).toEqual([c, b, a]);
    all.json.routes.forEach(expectValid);
    expect((await call("GET", `/routes?use_case=${encodeURIComponent(UC)}`)).json.routes.map((r: any) => r.id)).toEqual([b, a]);
    expect((await call("GET", "/routes?state=live")).json.routes.map((r: any) => r.id)).toEqual([b]);
    expect((await call("GET", `/routes?use_case=${encodeURIComponent(UC2)}&state=live`)).json.routes).toEqual([]);
    // Every principal of the tenant reads the routes.
    expect((await call("GET", "/routes", undefined, dfl(BOB))).json.routes).toHaveLength(3);

    for (const q of ["?q=sonnet", "?state=live&state=approved", "?use_case=fix", "?state=done", "?use_case=fix/prod-bug&limit=5"]) {
      const r = await call("GET", `/routes${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json.error).toBe("invalid_query");
    }
    expect((await call("GET", "/routes", undefined, null)).status).toBe(401);
  });

  it("reads one route of the tenant; 404 for another tenant or an unknown id; 400 for a malformed id; 503 before 0026", async () => {
    const id = (await approve()).json.id;
    const r = await call("GET", `/routes/${id}`);
    expect(r.status).toBe(200);
    expectValid(r.json);
    expect(r.json.id).toBe(id);
    expect((await call("GET", `/routes/${randomUUID()}`)).status).toBe(404);
    expect((await call("GET", "/routes/abc")).json.error).toBe("invalid_id");
    store.rows[0]!.tenant = "other-tenant";
    expect((await call("GET", `/routes/${id}`)).status).toBe(404);
    store.isReady = false;
    expect((await call("GET", `/routes/${id}`)).status).toBe(503);
    expect((await call("GET", "/routes")).status).toBe(503);
  });
});

describe("pure helpers", () => {
  it("the profile digest is stable and ignores the sha256 field", () => {
    const p = {
      source: "defaults" as const, sha256: null, weights: "stored_per_result" as const, min_runs_per_cell: 5, relative_margin_points: 5,
      relative_alpha: 0.05, relative_test: "mann-whitney-u" as const, absolute_bars: { same: 95, close: 85 },
    };
    expect(compareProfileSha256(p)).toBe(compareProfileSha256({ ...p, absolute_bars: { close: 85, same: 95 } }));
    expect(compareProfileSha256(p)).not.toBe(compareProfileSha256({ ...p, min_runs_per_cell: 6 }));
  });
  it("parseApproveBody defaults policy_version and fallback_agent", () => {
    const r = parseApproveBody(goodBody());
    expect(r).toMatchObject({ ok: true, value: { policy_version: "c8-1", fallback_agent: null, current_agent: null } });
  });
});
