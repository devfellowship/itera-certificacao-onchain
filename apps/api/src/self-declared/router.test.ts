/**
 * POST /self-declared-results and the owner-only run guard (task L3), over the fake store. The pg store
 * has its own test (store.pg.test.ts) against a migrated Postgres.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { issueSessionToken } from "../auth/session.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { resolveEvaluationRequest } from "../evaluations/resolve.js";
import type { EvaluationsStore } from "../evaluations/store.js";
import type { EvaluationsConfig } from "../evaluations/config.js";
import { FakeSelfDeclaredStore } from "./store.fake.js";
import type { RunOrigin, RunOriginLookup } from "./run-guard.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const H = (c: string) => c.repeat(64);
const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const BOB = "dfl:00000000-0000-4000-8000-00000000000b";
const AGENT_A = "0b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const AGENT_B = "1b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const dfl = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;
const siws = () => issueSessionToken("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", Date.now(), "siws").token;

const tmaRun = (repeat: number, score: number) => ({
  item_sha256: H("a"), repeat, status: score === 100 ? "pass" : "fail", score, wall_s: 212, cost_usd: 0.031, tokens_in: 51234, tokens_out: 3120, error_class: null,
  parts: { public_behavior: 20, hidden_behavior: score === 100 ? 50 : 30, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
});
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: "tma-local-result/1",
  agent_id: AGENT_A,
  task: { catalog: { slug: "webhook-ledger", version: 1 } },
  metrics_shape: "tma-score/1",
  grader_version: "1.1.0",
  runner: { version: "0.1.0", execution: "tma-sandbox", profile: "opencode", sandbox_image_id: `sha256:${H("d")}` },
  executor: { model_id: "openrouter/deepseek/deepseek-v4.1-flash", provider: "deepseek", route: "openrouter", harness: "opencode 1.18.31", variant: null, cost_source: "metered" },
  ran_from: "2026-10-26T12:00:00Z",
  ran_to: "2026-10-26T12:20:00Z",
  summary: { score: 90, runs: 2, items: 1 },
  runs: [tmaRun(1, 100), tmaRun(2, 80)],
  ...over,
});

class FakeLookup implements RunOriginLookup {
  runs = new Map<string, RunOrigin>();
  async originOf(id: string) {
    return this.runs.get(id) ?? null;
  }
}

let server: Server;
let base = "";
let store: FakeSelfDeclaredStore;
let lookup: FakeLookup;

async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

beforeEach(async () => {
  store = new FakeSelfDeclaredStore();
  store.agents.set(AGENT_A, { owner: ALICE, hasVersion: true });
  store.agents.set(AGENT_B, { owner: BOB, hasVersion: true });
  store.models.add("deepseek/deepseek-v4.1-flash");
  store.tasks.set("webhook-ledger", { id: "task-ledger", visibility: "public", owner: null, versions: [1, 2] });
  store.tasks.set("bobs-task", { id: "task-bob", visibility: "private", owner: BOB, versions: [1] });
  lookup = new FakeLookup();
  server = createApp(new FakeRepository(), { selfDeclared: { store, perDay: 3, web2BaseUrl: "https://web2.example/" }, runOrigins: lookup }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("POST /self-declared-results", () => {
  it("inserts, then answers unchanged for the same body and updated for new numbers, with the same ids", async () => {
    const a = await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body() });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ action: "inserted", result_origin: "self_declared", outcome: "fail", dry_run: false });
    expect(a.json.url).toBe(`https://web2.example/evaluations/${a.json.evaluation_id}`);
    expect(a.json.run_id).toBe(a.json.evaluation_id);
    const b = await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body() });
    expect(b).toMatchObject({ status: 200, json: { action: "unchanged", evaluation_id: a.json.evaluation_id } });
    const c = await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body({ summary: { score: 91, runs: 2, items: 1 } }) });
    expect(c).toMatchObject({ status: 200, json: { action: "updated", evaluation_id: a.json.evaluation_id } });
    expect(store.rows.size).toBe(1);
  });

  it("dry_run=1 checks everything and writes nothing", async () => {
    const r = await call("POST", "/self-declared-results?dry_run=1", { token: dfl(ALICE), body: body() });
    expect(r).toMatchObject({ status: 200, json: { action: "inserted", dry_run: true } });
    expect(store.rows.size).toBe(0);
  });

  it("refuses an unknown key with 400 unknown_key and its JSON path", async () => {
    const withActions = body();
    (withActions.runs as any[])[0].actions = [{ tool: "bash", input: "cat .env" }];
    const r = await call("POST", "/self-declared-results", { token: dfl(ALICE), body: withActions });
    expect(r).toMatchObject({ status: 400, json: { error: "unknown_key", path: "/runs/0/actions" } });
    const top = await call("POST", "/self-declared-results", { token: dfl(ALICE), body: { ...body(), transcript: "x" } });
    expect(top).toMatchObject({ status: 400, json: { error: "unknown_key", path: "/transcript" } });
    expect(store.rows.size).toBe(0);
  });

  it("refuses free text and an unknown provider with 400", async () => {
    const free = body();
    (free.executor as any).harness = "line one\nline two";
    expect((await call("POST", "/self-declared-results", { token: dfl(ALICE), body: free })).json).toMatchObject({ error: "invalid", path: "/executor/harness" });
    const prov = body();
    (prov.executor as any).provider = "acme";
    expect((await call("POST", "/self-declared-results", { token: dfl(ALICE), body: prov })).json).toMatchObject({ error: "unknown_provider" });
  });

  it("answers 401 without a session and 403 self_declared_dfl_only for a siws session", async () => {
    expect((await call("POST", "/self-declared-results", { body: body() })).status).toBe(401);
    expect(await call("POST", "/self-declared-results", { token: siws(), body: body() })).toMatchObject({ status: 403, json: { error: "self_declared_dfl_only" } });
  });

  it("answers 404 for another user's agent, and the same for an unknown agent", async () => {
    expect(await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body({ agent_id: AGENT_B }) })).toMatchObject({ status: 404, json: { error: "agent_not_found" } });
    expect((await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body({ agent_id: "2b6f3c2e-1d4a-4c8e-9f00-123456789abc" }) })).status).toBe(404);
  });

  it("answers 404 for an unknown catalog version and for another user's private task", async () => {
    expect(await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body({ task: { catalog: { slug: "webhook-ledger", version: 9 } } }) })).toMatchObject({ status: 404, json: { error: "task_version_not_found" } });
    expect(await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body({ task: { catalog: { slug: "bobs-task", version: 1 } } }) })).toMatchObject({ status: 404, json: { error: "task_not_found" } });
  });

  it("answers 409 task_slug_taken for a local task whose slug another task holds", async () => {
    const local = (slug: string) => ({ local: { slug, name: "My private task", contract_sha256: H("1"), environment_sha256: H("2"), hidden_tests_sha256: H("3") } });
    expect(await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body({ task: local("webhook-ledger") }) })).toMatchObject({ status: 409, json: { error: "task_slug_taken" } });
    expect((await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body({ task: local("alice-private") }) })).status).toBe(201);
    expect(await call("POST", "/self-declared-results", { token: dfl(BOB), body: body({ agent_id: AGENT_B, task: local("alice-private") }) })).toMatchObject({ status: 409, json: { error: "task_slug_taken" } });
  });

  it("answers 400 unknown_model for a model outside the catalog, and takes a route-prefixed or custom model", async () => {
    const m = (model_id: string, route = "openrouter") => body({ executor: { ...(body().executor as object), model_id, route } });
    expect(await call("POST", "/self-declared-results", { token: dfl(ALICE), body: m("acme/mystery-7b") })).toMatchObject({ status: 400, json: { error: "unknown_model" } });
    expect((await call("POST", "/self-declared-results", { token: dfl(ALICE), body: m("opencode-go/deepseek-v4-pro", "opencode-go") })).status).toBe(201);
    store.customModels.add(`${ALICE}|acme/mystery-7b`);
    expect((await call("POST", "/self-declared-results", { token: dfl(ALICE), body: m("acme/mystery-7b") })).status).toBe(201);
  });

  it("answers 413 above 1 MiB on this route, and the global 100 kB limit does not apply to it", async () => {
    const big = JSON.stringify({ ...body(), pad: "x".repeat(1024 * 1024) });
    expect(await call("POST", "/self-declared-results", { token: dfl(ALICE), raw: big })).toMatchObject({ status: 413, json: { error: "payload_too_large" } });
    const runs = Array.from({ length: 1500 }, (_, i) => tmaRun((i % 100) + 1, 80));
    const large = body({ summary: { score: 80, runs: 1500, items: 15 }, runs });
    expect(JSON.stringify(large).length).toBeGreaterThan(200_000);
    expect((await call("POST", "/self-declared-results", { token: dfl(ALICE), body: large })).status).toBe(201);
  });

  it("answers 400 not_json for a body that does not parse", async () => {
    expect(await call("POST", "/self-declared-results", { token: dfl(ALICE), raw: '{"format":' })).toMatchObject({ status: 400, json: { error: "not_json" } });
  });

  it("answers 429 self_declared_quota above the daily cap of new results", async () => {
    for (const v of ["a", "b", "c"]) {
      const r = await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body({ executor: { ...(body().executor as object), model_id: `opencode-go/model-${v}`, route: "opencode-go" } }) });
      expect(r.status).toBe(201);
    }
    const over = await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body() });
    expect(over).toMatchObject({ status: 429, json: { error: "self_declared_quota" } });
    // An update of an existing result is not a new row: the cap does not stop it.
    const again = await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body({ executor: { ...(body().executor as object), model_id: "opencode-go/model-a", route: "opencode-go" }, summary: { score: 1, runs: 2, items: 1 } }) });
    expect(again).toMatchObject({ status: 200, json: { action: "updated" } });
  });

  it("answers 503 schema_not_ready before migration 0021, and writes nothing", async () => {
    store.failWith = new SchemaNotReadyError("0021_self_declared_results.sql");
    expect(await call("POST", "/self-declared-results", { token: dfl(ALICE), body: body() })).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
  });
});

describe("self-declared run guard (plan Q4 = C)", () => {
  const RUN = "3b6f3c2e-1d4a-4c8e-9f00-123456789abc";
  beforeEach(() => lookup.runs.set(RUN, { ownerWallet: ALICE, resultOrigin: "self_declared" }));

  it("answers 404 to anyone but the owner on GET /runs/:id and GET /runs/:id/actions", async () => {
    for (const path of [`/runs/${RUN}`, `/runs/${RUN}/actions`]) {
      expect(await call("GET", path)).toMatchObject({ status: 404, json: { error: "run not found" } });
      expect(await call("GET", path, { token: dfl(BOB) })).toMatchObject({ status: 404, json: { error: "run not found" } });
      // The owner passes the guard (the runs router is not mounted here: Express answers 404 HTML, not the guard's JSON).
      const owner = await call("GET", path, { token: dfl(ALICE) });
      expect(owner.json?.error).not.toBe("run not found");
    }
  });

  it("answers 409 self_declared_run on publish, start-signature and feedback, even for the owner", async () => {
    for (const p of ["publish", "start-signature", "feedback"]) {
      expect(await call("POST", `/runs/${RUN}/${p}`, { token: dfl(ALICE), body: {} })).toMatchObject({ status: 409, json: { error: "self_declared_run" } });
    }
  });

  it("lets a hosted run through", async () => {
    const hosted = "4b6f3c2e-1d4a-4c8e-9f00-123456789abc";
    lookup.runs.set(hosted, { ownerWallet: ALICE, resultOrigin: "hosted" });
    expect((await call("GET", `/runs/${hosted}`)).json?.error).not.toBe("run not found");
    expect((await call("POST", `/runs/${hosted}/publish`, { token: dfl(ALICE), body: {} })).json?.error).not.toBe("self_declared_run");
  });
});

describe("POST /evaluations with a local agent", () => {
  it("answers 409 agent_is_local before any task, quota or payment", async () => {
    const calls: string[] = [];
    const stub = {
      getAgent: async () => ({ id: AGENT_A, ownerWallet: ALICE, name: "local", slug: null, repoFullName: null, agentPath: ".", model: "x/y", modelRelease: null, visibility: "private" as const, pinnedCommit: null, connector: "local" as const }),
      agentVersionFor: async () => (calls.push("version"), null),
      resolveTask: async () => (calls.push("task"), null),
      countRecentRuns: async () => (calls.push("quota"), 0),
    } as unknown as EvaluationsStore;
    const r = await resolveEvaluationRequest(stub, { runsPerWalletPerDay: 10 } as EvaluationsConfig, ALICE, { agentId: AGENT_A, taskIds: ["t"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject({ status: 409, body: { error: "agent_is_local" } });
    expect(calls).toEqual([]);
  });
});
