import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { taskToolEnvironment } from "../domain/task-environment.js";
import { issueSessionToken } from "../http/auth.js";
import type { EvaluationsConfig } from "./config.js";
import type { PaymentGateway } from "./solana-pay.js";
import { FakeEvaluationsStore } from "./store.fake.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const config: EvaluationsConfig = {
  baseFeeUsd: 0.1, fallbackPriceUsd: 0.2, quoteTtlMs: 120_000, quoteGraceMs: 15_000,
  treasury: "GZTkDGqnELbVMrnpq5rK8yizzJ5JpMxrTzdKyitrgWWp", runsPerWalletPerDay: 30, maxTasks: 9, webBaseUrl: "https://web.example",
};
const payments: PaymentGateway = {
  newReference: () => Keypair.generate().publicKey.toBase58(),
  transferUrl: () => "solana:x",
  buildTransferTx: async () => "AAAA",
  verify: async () => ({ ok: false, code: "not_found", message: "not found" }),
};
const MCP_CONTRACT = {
  environment: {
    dir: "environment",
    tools: { builtin: ["read", "edit"], mcp: [{ name: "postgres", transport: "http", image: "ghcr.io/itera/mcp-postgres:1", allowed_tools: ["query"] }] },
    run_egress: ["model-gateway", "mcp"],
  },
};

let server: Server;
let base: string;
let store: FakeEvaluationsStore;
const agentId = randomUUID();
const privateAgentId = randomUUID();

const call = async (method: string, path: string, wallet?: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(wallet ? { Authorization: `Bearer ${issueSessionToken(wallet).token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeEach(async () => {
  store = new FakeEvaluationsStore();
  const agent = { ownerWallet: OWNER, name: "Settle Wise", slug: "settlewise", repoFullName: "acme/agent", agentPath: ".", model: "qwen/qwen3-coder", modelRelease: null, pinnedCommit: null };
  store.agents.push({ ...agent, id: agentId, visibility: "listed", requires: [] });
  store.agents.push({ ...agent, id: privateAgentId, visibility: "private", requires: ["mcp:postgres"] });
  for (const id of [agentId, privateAgentId]) store.versions.push({ id: randomUUID(), agentId: id, commitSha: "9".repeat(40) });
  store.tasks.push(
    { taskId: "webhook-ledger", taskVersionId: null, slug: "webhook-ledger", name: "Webhook ledger", packId: "webhook-ledger", packVersion: "1", isPublic: true, runnable: true },
    { taskId: "pg-task", taskVersionId: null, slug: "pg-task", name: "PG task", packId: "pg-task", packVersion: "1", isPublic: true, runnable: true, contract: MCP_CONTRACT },
    { taskId: "mine", taskVersionId: null, slug: "mine", name: "Mine", packId: "mine", packVersion: "1", isPublic: false, ownerWallet: OWNER, runnable: true },
  );
  server = createApp(new FakeRepository(), { evaluations: { store, config, price: async () => ({ solUsdRate: 100, priceSource: "pyth", publishedAt: "2026-10-12T00:00:00Z" }), payments } }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("task tool environment (U28)", () => {
  it("reads the curated pack task.json: webhook-ledger declares built-in tools only", () => {
    const env = taskToolEnvironment({ packId: "webhook-ledger" });
    expect(env.mcp).toEqual([]);
    expect(env.builtin).toContain("bash");
    expect(env.run_egress).toEqual(["model-gateway"]);
  });
  it("prefers the stored contract's environment; an unknown pack gets the default", () => {
    expect(taskToolEnvironment({ packId: "pg-task", contract: MCP_CONTRACT }).mcp.map((s) => s.name)).toEqual(["postgres"]);
    expect(taskToolEnvironment({ packId: "../etc", contract: { editable_paths: ["src/**"] } }).mcp).toEqual([]);
  });
});

describe("GET /tasks/:idOrSlug/compatibility?agentId=", () => {
  it("compatible pair: no requirement against webhook-ledger", async () => {
    const r = await call("GET", `/tasks/webhook-ledger/compatibility?agentId=${agentId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ taskId: "webhook-ledger", agentId, compatible: true, reasons: [], requires: [] });
    expect(r.body.environment).toMatchObject({ mcp: [], runEgress: ["model-gateway"] });
  });
  it("incompatible pair: the agent requires mcp:postgres, webhook-ledger has no MCP server", async () => {
    const r = await call("GET", `/tasks/webhook-ledger/compatibility?agentId=${privateAgentId}`, OWNER);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ compatible: false, reasons: [{ code: "missing_mcp_server", requirement: "mcp:postgres" }] });
    const ok = await call("GET", `/tasks/pg-task/compatibility?agentId=${privateAgentId}`, OWNER);
    expect(ok.body).toMatchObject({ compatible: true, environment: { mcp: [{ name: "postgres", transport: "http", allowedTools: ["query"] }] } });
    expect(JSON.stringify(ok.body)).not.toContain("ghcr.io"); // no image, seed or secret in the answer
  });
  it("hides a private agent or a private task of another wallet, and checks agentId", async () => {
    expect((await call("GET", `/tasks/webhook-ledger/compatibility?agentId=${privateAgentId}`, OTHER)).status).toBe(404);
    expect((await call("GET", `/tasks/webhook-ledger/compatibility?agentId=${privateAgentId}`)).status).toBe(404);
    expect((await call("GET", `/tasks/mine/compatibility?agentId=${agentId}`, OTHER)).status).toBe(404);
    expect((await call("GET", `/tasks/mine/compatibility?agentId=${agentId}`, OWNER)).status).toBe(200);
    expect((await call("GET", `/tasks/nope/compatibility?agentId=${agentId}`)).status).toBe(404);
    expect((await call("GET", `/tasks/webhook-ledger/compatibility?agentId=x`)).status).toBe(400);
  });
});

describe("POST /evaluations/quote refuses an incompatible pair before payment (U28)", () => {
  it("422 with reasons, and no payment row", async () => {
    const r = await call("POST", "/evaluations/quote", OWNER, { agentId: privateAgentId, taskIds: ["webhook-ledger", "pg-task"] });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: "incompatible", incompatible: [{ taskId: "webhook-ledger", slug: "webhook-ledger", reasons: [{ code: "missing_mcp_server", requirement: "mcp:postgres" }] }] });
    expect(r.body.error).toMatch(/MCP server "postgres"/);
    expect(store.payments).toHaveLength(0);
  });
  it("a compatible pair is quoted, and the stored tasks carry no contract", async () => {
    const r = await call("POST", "/evaluations/quote", OWNER, { agentId: privateAgentId, taskIds: ["pg-task"] });
    expect(r.status).toBe(201);
    expect(store.payments[0]!.tasks[0]).not.toHaveProperty("contract");
    expect(store.payments[0]!.tasks[0]).not.toHaveProperty("ownerWallet");
  });
});
