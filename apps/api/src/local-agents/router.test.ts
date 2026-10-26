/**
 * Local agents and custom models (task L4), over the fake store and the real app. The pg store has its
 * own test (store.pg.test.ts) against a migrated Postgres.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROVIDER_KEYS, ROUTE_KEYS } from "@itera/contracts/model-catalog";
import { createApp } from "../app.js";
import { issueSessionToken } from "../auth/session.js";
import { FakeGithubAgentsRepository } from "../domain/github-agents-repository.fake.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { requireWallet } from "../http/auth.js";
import { resolveEvaluationRequest } from "../evaluations/resolve.js";
import type { EvaluationsConfig } from "../evaluations/config.js";
import type { EvaluationsStore } from "../evaluations/store.js";
import { FakeLocalAgentsStore } from "./store.fake.js";
import { localCommitSha } from "./store.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const BOB = "dfl:00000000-0000-4000-8000-00000000000b";
const token = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;

let server: Server;
let base = "";
let store: FakeLocalAgentsStore;
let ghRepo: FakeGithubAgentsRepository;

async function call(method: string, path: string, who?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${token(who)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
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

const agentBody = (over: Record<string, unknown> = {}) => ({
  name: "Samuel harness", model_id: "deepseek/deepseek-v4.1-flash", provider_key: "deepseek", route_key: "openrouter", harness: "opencode 1.18.31", ...over,
});

beforeEach(async () => {
  store = new FakeLocalAgentsStore();
  store.models.set("deepseek/deepseek-v4.1-flash", { label: "DeepSeek V4.1 Flash", enabled: true });
  store.models.set("anthropic/claude-opus-4.1", { label: "Claude Opus 4.1", enabled: false });
  ghRepo = new FakeGithubAgentsRepository();
  server = createApp(new FakeRepository(), {
    localAgents: { store, maxCustomModels: 3 },
    github: { repo: ghRepo, github: () => { throw new Error("no github in this test"); }, requireWallet, stateSecret: () => "test-session-secret" },
  }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("GET /model-options", () => {
  it("lists the provider and route enums, the enabled known models, and only the caller's custom models", async () => {
    expect((await call("GET", "/model-options")).status).toBe(401);
    expect((await call("POST", "/me/models", ALICE, { id: "acme/mystery-7b", label: "Mystery 7B", provider_label: "Acme Labs", route_key: "ollama" })).status).toBe(201);
    const a = await call("GET", "/model-options", ALICE);
    expect(a.status).toBe(200);
    expect(a.json.providers.map((p: { key: string }) => p.key)).toEqual(PROVIDER_KEYS);
    expect(a.json.routes.map((r: { key: string }) => r.key)).toEqual(ROUTE_KEYS);
    expect(a.json.models).toEqual([{ id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", provider: "deepseek", route: "openrouter", known: true }]);
    expect(a.json.custom).toEqual([{ id: "acme/mystery-7b", label: "Mystery 7B", provider: null, providerLabel: "Acme Labs", route: "ollama", known: false }]);
    // The tenant rule: Bob does not see Alice's custom model.
    const b = await call("GET", "/model-options", BOB);
    expect(b.json.custom).toEqual([]);
    expect(b.json.models).toEqual(a.json.models);
  });

  it("answers with custom: [] before 0021 (and the writes answer 503 schema_not_ready)", async () => {
    store.ready = false;
    const r = await call("GET", "/model-options", ALICE);
    expect(r).toMatchObject({ status: 200, json: { custom: [] } });
    expect(r.json.models.length).toBe(1);
    expect(await call("POST", "/me/models", ALICE, { id: "acme/x", label: "X", provider_key: "deepseek", route_key: "ollama" })).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
    expect((await call("DELETE", "/me/models/acme/x", ALICE)).status).toBe(503);
    expect((await call("POST", "/agents/local", ALICE, agentBody())).status).toBe(503);
  });
});

describe("POST /me/models and DELETE /me/models/:id", () => {
  it("refuses a known model, a duplicate, a bad provider or route, and more than the cap", async () => {
    const m = (over: Record<string, unknown>) => call("POST", "/me/models", ALICE, { id: "acme/m1", label: "M1", provider_key: "deepseek", route_key: "ollama", ...over });
    expect(await m({ id: "deepseek/deepseek-v4.1-flash" })).toMatchObject({ status: 400, json: { error: "known_model" } });
    expect(await m({ id: "openrouter/anthropic/claude-opus-4.1" })).toMatchObject({ status: 400, json: { error: "known_model" } }); // a disabled row is still known
    expect(await m({ id: "ollama/llama-9" })).toMatchObject({ status: 400, json: { error: "known_model" } }); // a route-prefixed id needs no row
    expect(await m({ provider_key: "acme" })).toMatchObject({ status: 400, json: { error: "unknown_provider" } });
    expect(await m({ route_key: "carrier-pigeon" })).toMatchObject({ status: 400, json: { error: "unknown_route" } });
    expect(await m({ provider_label: "Acme" })).toMatchObject({ status: 400, json: { error: "invalid" } }); // both
    expect(await m({ id: "not a model" })).toMatchObject({ status: 400, json: { error: "invalid_model_id" } });
    expect(await m({ label: "line\nbreak" })).toMatchObject({ status: 400, json: { error: "invalid" } });
    expect((await m({})).status).toBe(201);
    expect(await m({})).toMatchObject({ status: 409, json: { error: "custom_model_exists" } });
    expect((await m({ id: "acme/m2" })).status).toBe(201);
    expect((await m({ id: "acme/m3" })).status).toBe(201);
    expect(await m({ id: "acme/m4" })).toMatchObject({ status: 409, json: { error: "custom_model_limit" } });
    // The same id is free for another tenant.
    expect((await call("POST", "/me/models", BOB, { id: "acme/m1", label: "M1", provider_key: "deepseek", route_key: "ollama" })).status).toBe(201);
  });

  it("deletes a custom model only when no agent of the caller uses it", async () => {
    await call("POST", "/me/models", ALICE, { id: "acme/m1", label: "M1", provider_key: "deepseek", route_key: "ollama" });
    const a = await call("POST", "/agents/local", ALICE, agentBody({ model_id: "acme/m1", route_key: "ollama" }));
    expect(a.status).toBe(201);
    expect(await call("DELETE", "/me/models/acme/m1", ALICE)).toMatchObject({ status: 409, json: { error: "model_in_use" } });
    expect((await call("DELETE", "/me/models/acme/m1", BOB)).status).toBe(404);
    expect((await call("PATCH", `/agents/${a.json.agent.id}`, ALICE, { model_id: "deepseek/deepseek-v4.1-flash" })).status).toBe(200);
    expect((await call("DELETE", "/me/models/acme%2Fm1", ALICE)).status).toBe(204);
    expect((await call("GET", "/model-options", ALICE)).json.custom).toEqual([]);
  });
});

describe("POST /agents/local", () => {
  it("creates a local agent with no repo, the declared provider and route, and one empty version", async () => {
    const r = await call("POST", "/agents/local", ALICE, agentBody());
    expect(r.status).toBe(201);
    expect(r.json.agent).toMatchObject({
      connector: "local", ownerWallet: ALICE, name: "Samuel harness", model: "deepseek/deepseek-v4.1-flash", providerKey: "deepseek",
      routeKey: "openrouter", harness: "opencode 1.18.31", visibility: "private", status: "active", repoFullName: null,
      latestVersion: { commitSha: localCommitSha("Samuel harness"), fileCount: 0 },
    });
    expect(localCommitSha("Samuel harness")).toMatch(/^local-[0-9a-f]{40}$/);
    // GET /agents/:id answers for the owner only; GET /agents lists it only with include=local.
    const id = r.json.agent.id;
    expect((await call("GET", `/agents/${id}`, ALICE)).json.agent.connector).toBe("local");
    expect((await call("GET", `/agents/${id}`, BOB)).status).toBe(404);
    expect((await call("GET", "/agents", ALICE)).json.agents).toEqual([]);
    expect((await call("GET", "/agents?include=local", ALICE)).json.agents.map((a: { id: string }) => a.id)).toEqual([id]);
    expect((await call("GET", "/agents?include=local", BOB)).json.agents).toEqual([]);
  });

  it("refuses an unknown provider, route or model, and a name the caller already has", async () => {
    expect(await call("POST", "/agents/local", ALICE, agentBody({ provider_key: "acme" }))).toMatchObject({ status: 400, json: { error: "unknown_provider" } });
    expect(await call("POST", "/agents/local", ALICE, agentBody({ route_key: "fax" }))).toMatchObject({ status: 400, json: { error: "unknown_route" } });
    expect(await call("POST", "/agents/local", ALICE, agentBody({ model_id: "acme/mystery-7b" }))).toMatchObject({ status: 400, json: { error: "unknown_model" } });
    // Another tenant's custom model is unknown to Alice.
    await call("POST", "/me/models", BOB, { id: "acme/mystery-7b", label: "M", provider_key: "deepseek", route_key: "ollama" });
    expect(await call("POST", "/agents/local", ALICE, agentBody({ model_id: "acme/mystery-7b" }))).toMatchObject({ status: 400, json: { error: "unknown_model" } });
    expect((await call("POST", "/agents/local", ALICE, agentBody({ model_id: "ollama/qwen3-coder", route_key: "ollama", provider_key: null }))).status).toBe(201);
    expect(await call("POST", "/agents/local", ALICE, agentBody({ model_id: "ollama/qwen3-coder", route_key: "ollama" }))).toMatchObject({ status: 409, json: { error: "agent_name_taken" } });
    expect((await call("POST", "/agents/local", undefined, agentBody())).status).toBe(401);
  });
});

describe("PATCH /agents/:id of a local agent", () => {
  it("changes the name, description, model, provider, route and harness; owner only", async () => {
    const id = (await call("POST", "/agents/local", ALICE, agentBody())).json.agent.id;
    const p = await call("PATCH", `/agents/${id}`, ALICE, { name: "Renamed", description: "Local only.", model_id: "opencode-go/kimi-k3", provider_key: "kimi", route_key: "opencode-go", harness: null });
    expect(p.status).toBe(200);
    expect(p.json.agent).toMatchObject({ name: "Renamed", description: "Local only.", model: "opencode-go/kimi-k3", providerKey: "kimi", routeKey: "opencode-go", harness: null, connector: "local" });
    expect((await call("PATCH", `/agents/${id}`, BOB, { name: "Mine now" })).status).toBe(404);
    expect(await call("PATCH", `/agents/${id}`, ALICE, { provider_key: "acme" })).toMatchObject({ status: 400, json: { error: "unknown_provider" } });
    expect(await call("PATCH", `/agents/${id}`, ALICE, { model_id: "acme/none" })).toMatchObject({ status: 400, json: { error: "unknown_model" } });
    expect(await call("PATCH", `/agents/${id}`, ALICE, {})).toMatchObject({ status: 400, json: { error: "nothing_to_update" } });
  });
});

describe("a local agent cannot start a hosted evaluation", () => {
  it("POST /evaluations answers 409 agent_is_local before any task, quota or payment check", async () => {
    const calls: string[] = [];
    const stub = {
      getAgent: async () => ({ id: "a", ownerWallet: ALICE, name: "local", slug: null, repoFullName: null, agentPath: ".", model: "x/y", modelRelease: null, visibility: "private" as const, pinnedCommit: null, connector: "local" as const }),
      agentVersionFor: async () => (calls.push("version"), null),
      resolveTask: async () => (calls.push("task"), null),
      countRecentRuns: async () => (calls.push("quota"), 0),
    } as unknown as EvaluationsStore;
    const r = await resolveEvaluationRequest(stub, { runsPerWalletPerDay: 10 } as EvaluationsConfig, ALICE, { agentId: "a", taskIds: ["t"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject({ status: 409, body: { error: "agent_is_local" } });
    expect(calls).toEqual([]);
  });
});
