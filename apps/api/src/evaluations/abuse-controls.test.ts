/**
 * Abuse controls of the free path (plan 20261015-testmyagent-web2-client, ADR-9, task T10):
 * the daily run quota, the configurable queued bound, the `users.disabled` kill switch.
 * The pg side of the quota (advisory lock, parallel requests) is in store.contract.test.ts.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createAccountGuard } from "../auth/account-guard.js";
import { issueSessionToken } from "../auth/session.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { FakeUsersStore } from "../domain/users-store.fake.js";
import type { PaymentGateway } from "../payments/adapters/solana-pay-gateway.js";
import { evaluationsConfigFromEnv, type EvaluationsConfig } from "./config.js";
import { FakeEvaluationsStore } from "./store.fake.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SECRET = "k".repeat(48);
const KEY = "sk-or-v1-" + "a".repeat(40);
const HOUR = 3_600_000;
const LEDGER_CONTRACT = JSON.parse(readFileSync(new URL("../../../../benchmarks/webhook-ledger/task.json", import.meta.url), "utf-8"));
const baseConfig: EvaluationsConfig = {
  baseFeeUsd: 0.1,
  fallbackPriceUsd: 0.2,
  quoteTtlMs: 120_000,
  quoteGraceMs: 15_000,
  treasury: "GZTkDGqnELbVMrnpq5rK8yizzJ5JpMxrTzdKyitrgWWp",
  runsPerWalletPerDay: 30,
  maxTasks: 9,
  webBaseUrl: "https://web.example",
};

let server: Server;
let base: string;
let store: FakeEvaluationsStore;
let users: FakeUsersStore;
let clock: number;
let agentId: string;

const dflToken = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;

async function start(config: EvaluationsConfig) {
  const gateway: PaymentGateway = {
    newReference: () => Keypair.generate().publicKey.toBase58(),
    transferUrl: () => "solana:x",
    buildTransferTx: async () => "AAAA",
    verify: async () => ({ ok: false as const, code: "not_found" as const, message: "not found" }),
  };
  server = createApp(new FakeRepository(), {
    evaluations: {
      store,
      config,
      price: async () => ({ solUsdRate: 100, priceSource: "pyth", publishedAt: new Date().toISOString() }),
      payments: gateway,
      runKeySecret: SECRET,
      now: () => clock,
    },
    dflAuth: { users },
  }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}
const freeBody = (taskIds: string[] = ["webhook-ledger"]) => ({ agentId, taskIds, modelApiKey: KEY });
/** Ends every run of the store, so the queued bound does not hide the quota. */
const finishRuns = () => store.runs.forEach((r) => Object.assign(r, { status: "pass" }));

beforeEach(() => {
  store = new FakeEvaluationsStore();
  users = new FakeUsersStore();
  clock = Date.parse("2026-10-15T12:00:00Z");
  agentId = randomUUID();
  store.agents.push({ id: agentId, ownerWallet: WALLET, name: "Settle Wise", slug: "settlewise", repoFullName: "acme/agent", agentPath: ".", model: "qwen/qwen3-coder", modelRelease: null, visibility: "listed", pinnedCommit: null, requires: [] });
  store.versions.push({ id: randomUUID(), agentId, commitSha: "9f2c1ab0".padEnd(40, "0") });
  for (const id of ["webhook-ledger", "rate-limiter"]) {
    store.tasks.push({ taskId: id, taskVersionId: null, slug: id, name: id, packId: id, packVersion: "1", isPublic: true, runnable: true, contract: LEDGER_CONTRACT });
  }
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("daily run quota (TMA_RUNS_PER_USER_PER_DAY)", () => {
  it("the 11th run in 24 h answers 429 quota_exceeded with resetAt; 24 h after the oldest run it passes again", async () => {
    await start({ ...baseConfig, maxQueuedRunsPerUser: 100, runsPerUserPerDay: 10 });
    const token = dflToken(`dfl:${randomUUID()}`);
    const firstRunAt = clock;
    for (let i = 0; i < 10; i++) {
      const res = await call("POST", "/evaluations", token, freeBody());
      expect(res.status).toBe(202);
      clock += 60_000;
    }
    const over = await call("POST", "/evaluations", token, freeBody());
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: "quota_exceeded", limit: 10, used: 10 });
    expect(over.body.resetAt).toBe(new Date(firstRunAt + 24 * HOUR).toISOString());
    expect(store.runs).toHaveLength(10);
    // 24 h after the first run, exactly one slot is free.
    clock = firstRunAt + 24 * HOUR + 1;
    expect((await call("POST", "/evaluations", token, freeBody())).status).toBe(202);
    expect((await call("POST", "/evaluations", token, freeBody())).status).toBe(429);
  });

  it("an evaluation of N tasks counts N runs, and the whole evaluation is refused when it does not fit", async () => {
    await start({ ...baseConfig, maxQueuedRunsPerUser: 100, runsPerUserPerDay: 10 });
    const token = dflToken(`dfl:${randomUUID()}`);
    const two = freeBody(["webhook-ledger", "rate-limiter"]);
    for (let i = 0; i < 4; i++) expect((await call("POST", "/evaluations", token, two)).status).toBe(202);
    expect(store.runs).toHaveLength(8);
    // 8 used + 2 new = 10: fits. 10 used + 2 new: refused.
    expect((await call("POST", "/evaluations", token, two)).status).toBe(202);
    const over = await call("POST", "/evaluations", token, two);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("quota_exceeded");
    expect(store.runs).toHaveLength(10);
    expect(store.evaluations).toHaveLength(5);
  });

  it("is per user: another principal keeps its own quota", async () => {
    await start({ ...baseConfig, maxQueuedRunsPerUser: 100, runsPerUserPerDay: 2 });
    const a = dflToken(`dfl:${randomUUID()}`);
    const b = dflToken(`dfl:${randomUUID()}`);
    for (let i = 0; i < 2; i++) expect((await call("POST", "/evaluations", a, freeBody())).status).toBe(202);
    expect((await call("POST", "/evaluations", a, freeBody())).status).toBe(429);
    expect((await call("POST", "/evaluations", b, freeBody())).status).toBe(202);
  });

  it("parallel requests cannot both pass the last slot", async () => {
    await start({ ...baseConfig, maxQueuedRunsPerUser: 100, runsPerUserPerDay: 3 });
    const token = dflToken(`dfl:${randomUUID()}`);
    const results = await Promise.all(Array.from({ length: 8 }, () => call("POST", "/evaluations", token, freeBody())));
    expect(results.filter((r) => r.status === 202)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
    expect(store.runs).toHaveLength(3);
  });

  it("defaults to 10 a day and 3 queued when the config sets neither", async () => {
    await start({ ...baseConfig });
    const token = dflToken(`dfl:${randomUUID()}`);
    for (let i = 0; i < 3; i++) expect((await call("POST", "/evaluations", token, freeBody())).status).toBe(202);
    expect((await call("POST", "/evaluations", token, freeBody())).body.code).toBe("too_many_queued");
    for (let round = 0; round < 2; round++) {
      finishRuns();
      for (let i = 0; i < 3; i++) expect((await call("POST", "/evaluations", token, freeBody())).status).toBe(202);
    }
    // 9 runs so far; the 10th is the last one allowed.
    finishRuns();
    expect((await call("POST", "/evaluations", token, freeBody())).status).toBe(202);
    finishRuns();
    const res = await call("POST", "/evaluations", token, freeBody());
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("quota_exceeded");
  });
});

describe("queued bound (TMA_MAX_QUEUED_RUNS_PER_USER)", () => {
  it("the config reads the env, with the ADR-9 defaults", () => {
    expect(evaluationsConfigFromEnv({})).toMatchObject({ maxQueuedRunsPerUser: 3, runsPerUserPerDay: 10 });
    expect(evaluationsConfigFromEnv({ TMA_MAX_QUEUED_RUNS_PER_USER: "5", TMA_RUNS_PER_USER_PER_DAY: "20" })).toMatchObject({ maxQueuedRunsPerUser: 5, runsPerUserPerDay: 20 });
    expect(evaluationsConfigFromEnv({ TMA_MAX_QUEUED_RUNS_PER_USER: " ", TMA_RUNS_PER_USER_PER_DAY: "" })).toMatchObject({ maxQueuedRunsPerUser: 3, runsPerUserPerDay: 10 });
  });

  it("an invalid value fails at boot instead of turning the limit into NaN", () => {
    for (const bad of ["abc", "0", "-1", "2.5"]) {
      expect(() => evaluationsConfigFromEnv({ TMA_MAX_QUEUED_RUNS_PER_USER: bad })).toThrow(/TMA_MAX_QUEUED_RUNS_PER_USER/);
      expect(() => evaluationsConfigFromEnv({ TMA_RUNS_PER_USER_PER_DAY: bad })).toThrow(/TMA_RUNS_PER_USER_PER_DAY/);
    }
  });

  it("uses the configured bound for too_many_queued", async () => {
    await start({ ...baseConfig, ...evaluationsConfigFromEnv({ TMA_MAX_QUEUED_RUNS_PER_USER: "2" }) });
    const token = dflToken(`dfl:${randomUUID()}`);
    expect((await call("POST", "/evaluations", token, freeBody())).status).toBe(202);
    expect((await call("POST", "/evaluations", token, freeBody())).status).toBe(202);
    const res = await call("POST", "/evaluations", token, freeBody());
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("too_many_queued");
    expect(res.body.error).toContain("max 2");
  });
});

describe("kill switch (users.disabled)", () => {
  async function login(disabled: boolean) {
    const dflUserId = randomUUID();
    const row = await users.upsertDflLogin({ dflUserId, email: "u@example.com", iamLevel: 0 });
    users.rows.set(row.principalId, { ...row, disabled });
    return { id: row.principalId, token: dflToken(row.principalId) };
  }

  it("a disabled account gets 403 account_disabled on every write route; public GETs keep working", async () => {
    await start({ ...baseConfig });
    const { token } = await login(true);
    for (const [method, path] of [
      ["POST", "/evaluations"],
      ["POST", "/evaluations/quote"],
      ["POST", `/evaluations/${randomUUID()}/cancel`],
      ["PATCH", "/me"],
      ["PUT", "/admin/profiles/x"],
      ["DELETE", "/me/avatar"],
    ] as const) {
      const res = await call(method, path, token, {});
      expect([method, path, res.status, res.body.error]).toEqual([method, path, 403, "account_disabled"]);
    }
    expect(store.evaluations).toHaveLength(0);
    expect((await call("GET", "/")).status).toBe(200);
    expect((await call("GET", "/health")).status).toBe(200);
    // Even with the disabled session attached, a public GET answers.
    expect((await call("GET", "/", token)).status).toBe(200);
  });

  it("an enabled account, an account without a row, and a siws wallet are not blocked", async () => {
    await start({ ...baseConfig });
    const enabled = await login(false);
    expect((await call("POST", "/evaluations", enabled.token, freeBody())).status).toBe(202);
    const noRow = dflToken(`dfl:${randomUUID()}`);
    expect((await call("POST", "/evaluations", noRow, freeBody())).status).toBe(202);
    // A siws principal skips the lookup and reaches the (paid) route.
    const spy = vi.spyOn(users, "get");
    const siws = issueSessionToken(WALLET, Date.now(), "siws").token;
    expect((await call("POST", "/evaluations/quote", siws, {})).status).not.toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers 503 when the users store fails (fail closed), and does not cache the failure", async () => {
    await start({ ...baseConfig });
    const { id, token } = await login(false);
    const get = vi.spyOn(users, "get").mockRejectedValueOnce(new Error("db down"));
    const res = await call("POST", "/evaluations", token, freeBody());
    expect(res).toMatchObject({ status: 503, body: { error: "users_store_unavailable" } });
    get.mockRestore();
    expect(users.rows.get(id)).toBeDefined();
    expect((await call("POST", "/evaluations", token, freeBody())).status).toBe(202);
  });
});

describe("account guard cache", () => {
  async function guardApp(ttlMs: number, now: () => number) {
    const { default: express } = await import("express");
    const app = express();
    app.use(createAccountGuard({ users, ttlMs, now }));
    app.post("/w", (_req, res) => void res.json({ ok: true }));
    const s = app.listen(0);
    await new Promise<void>((r) => s.once("listening", r));
    return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/w` };
  }

  it("looks the account up once per TTL, then sees a change", async () => {
    let t = 1_000_000;
    const { s, url } = await guardApp(30_000, () => t);
    try {
      const row = await users.upsertDflLogin({ dflUserId: randomUUID(), email: null, iamLevel: null });
      const token = dflToken(row.principalId);
      const get = vi.spyOn(users, "get");
      const post = () => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
      expect(get).toHaveBeenCalledTimes(1);
      // The account is disabled: the cached answer holds for 30 s, then the ban applies.
      users.rows.set(row.principalId, { ...row, disabled: true });
      t += 29_000;
      expect((await post()).status).toBe(200);
      t += 2_000;
      const banned = await post();
      expect(banned.status).toBe(403);
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
