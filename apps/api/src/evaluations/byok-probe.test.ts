/**
 * T8 (plan 20261015-testmyagent-web2-client, ADR-5): the OpenRouter key probe on the free path,
 * `POST /models/access`, and the platform-key flag. OpenRouter is a mocked fetch.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { issueSessionToken } from "../auth/session.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { decryptRunKey } from "../domain/run-key.js";
import type { PriceLookup } from "../domain/model-prices.js";
import { createOpenRouterKeyProbe } from "../models/openrouter-key.js";
import { PLATFORM_KEY_OFF, type PlatformKeyConfig } from "../models/platform-key.js";
import type { PaymentGateway } from "../payments/adapters/solana-pay-gateway.js";
import type { EvaluationsConfig } from "./config.js";
import { FakeEvaluationsStore } from "./store.fake.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SECRET = "k".repeat(48);
const FRAGMENT = "USERKEYSECRETPART";
const KEY = `sk-or-v1-${FRAGMENT}${FRAGMENT}`;
const PLATFORM_KEY = "sk-or-v1-PLATFORMKEYPLATFORMKEY0000";
const CHEAP = "qwen/qwen3-coder";
const PRICEY = "anthropic/claude-opus";
const GO = "opencode-go/deepseek-v4.1-flash";
const LEDGER_CONTRACT = JSON.parse(readFileSync(new URL("../../../../benchmarks/tsk_webhook_dup/task.json", import.meta.url), "utf-8"));
const config: EvaluationsConfig = {
  baseFeeUsd: 0.1,
  fallbackPriceUsd: 0.2,
  quoteTtlMs: 120_000,
  quoteGraceMs: 15_000,
  treasury: "GZTkDGqnELbVMrnpq5rK8yizzJ5JpMxrTzdKyitrgWWp",
  runsPerWalletPerDay: 30,
  maxTasks: 9,
  webBaseUrl: "https://web.example",
  maxQueuedRunsPerUser: 50,
};
const prices: PriceLookup = async (id) => (id === CHEAP ? { prompt: 0.0000002, completion: 0.0000008 } : id === PRICEY ? { prompt: 0.000015, completion: 0.000075 } : null);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let server: Server | undefined;
let base: string;
let store: FakeEvaluationsStore;
let agents: Record<string, string>;
let logs: string[];

async function start(openrouter: typeof fetch, platformKey: PlatformKeyConfig = PLATFORM_KEY_OFF) {
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x) ?? String(x))).join(" ")));
  }
  store = new FakeEvaluationsStore();
  const gateway: PaymentGateway = {
    newReference: () => Keypair.generate().publicKey.toBase58(),
    transferUrl: () => "solana:x",
    buildTransferTx: async () => "AAAA",
    verify: async () => ({ ok: false as const, code: "not_found" as const, message: "not found" }),
  };
  agents = {};
  for (const model of [CHEAP, PRICEY, GO]) {
    const id = randomUUID();
    agents[model] = id;
    store.agents.push({ id, ownerWallet: OWNER, name: "A", slug: null, repoFullName: "acme/agent", agentPath: ".", model, modelRelease: null, visibility: "listed", pinnedCommit: null, requires: [] });
    store.versions.push({ id: randomUUID(), agentId: id, commitSha: "9f2c1ab0".padEnd(40, "0") });
  }
  store.tasks.push(
    { taskId: "webhook-ledger", taskVersionId: null, slug: "webhook-ledger", name: "Webhook ledger", packId: "webhook-ledger", packVersion: "1", isPublic: true, runnable: true, contract: LEDGER_CONTRACT },
    { taskId: "rate-limiter", taskVersionId: null, slug: "rate-limiter", name: "Rate limiter", packId: "rate-limiter", packVersion: "1", isPublic: true, runnable: true, contract: LEDGER_CONTRACT },
  );
  server = createApp(new FakeRepository(), {
    evaluations: {
      store,
      config,
      price: async () => ({ solUsdRate: 100, priceSource: "pyth", publishedAt: new Date().toISOString() }),
      payments: gateway,
      runKeySecret: SECRET,
      probeModelKey: createOpenRouterKeyProbe({ fetchFn: openrouter }),
      platformKey,
      modelPrice: prices,
      // L15a: these tests prove the hosted dfl path with the flag on (off by default).
      web2Hosted: true,
    },
    modelsAccess: { probe: { fetchFn: openrouter } },
  }).listen(0);
  await new Promise<void>((r) => server!.once("listening", r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  // Every test: no log line holds the user key or a part of it.
  expect(logs.join("\n")).not.toContain(FRAGMENT);
  vi.restoreAllMocks();
});

const dfl = () => issueSessionToken(`dfl:${randomUUID()}`, Date.now(), "dfl").token;

async function call(path: string, token: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) as Record<string, any> };
}
const evaluate = (token: string, model: string, extra: Record<string, unknown> = { modelApiKey: KEY }) =>
  call("/evaluations", token, { agentId: agents[model], taskIds: ["webhook-ledger"], ...extra });

const ok = () => vi.fn<typeof fetch>(async () => json(200, { data: { label: "sk-or-v1-abc...", limit_remaining: 9.5, is_free_tier: false } }));

describe("POST /evaluations — the OpenRouter key probe (free path)", () => {
  it("401 from OpenRouter → 422 model_key_invalid and zero runs rows", async () => {
    const f = vi.fn<typeof fetch>(async () => json(401, { error: { message: "No auth credentials found", code: 401 } }));
    await start(f);
    const res = await evaluate(dfl(), CHEAP);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("model_key_invalid");
    expect(res.text).not.toContain(FRAGMENT);
    expect(f).toHaveBeenCalledTimes(1);
    expect(store.evaluations).toHaveLength(0);
    expect(store.runs).toHaveLength(0);
  });

  it("limit_remaining 0 → 422 model_key_no_credit, nothing written", async () => {
    await start(vi.fn<typeof fetch>(async () => json(200, { data: { label: "k", limit_remaining: 0 } })));
    const res = await evaluate(dfl(), CHEAP);
    expect(res).toMatchObject({ status: 422, body: { code: "model_key_no_credit" } });
    expect(store.runs).toHaveLength(0);
  });

  it("an unknown 200 body → accepted (202), the key is sealed, the warning has no key", async () => {
    await start(vi.fn<typeof fetch>(async () => json(200, { unexpected: true })));
    const res = await evaluate(dfl(), CHEAP);
    expect(res.status).toBe(202);
    expect(store.runs).toHaveLength(1);
    expect(decryptRunKey(store.runKeys.get(store.runs[0]!.id)!, SECRET)).toBe(KEY);
    expect(logs.some((l) => l.includes("unknown body shape"))).toBe(true);
  });

  it("a timeout → 503 model_key_probe_unavailable with Retry-After, and no runs", async () => {
    const hang = vi.fn<typeof fetch>((_u, init) => new Promise((_r, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason))));
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("timed out", "TimeoutError")), 10);
      return c.signal;
    });
    await start(hang);
    const res = await evaluate(dfl(), CHEAP);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("model_key_probe_unavailable");
    expect(res.headers.get("retry-after")).toBe("30");
    expect(store.evaluations).toHaveLength(0);
    expect(store.runs).toHaveLength(0);
  });

  it("a valid key → 202; the probe got the bearer key", async () => {
    const f = ok();
    await start(f);
    expect((await evaluate(dfl(), CHEAP)).status).toBe(202);
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("opencode-go model ids keep their BYOK rule: the key is required and probed like any other", async () => {
    const f = ok();
    await start(f);
    expect(await evaluate(dfl(), GO, {})).toMatchObject({ status: 422, body: { code: "model_key_required" } });
    expect(f).not.toHaveBeenCalled();
    expect((await evaluate(dfl(), GO)).status).toBe(202);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("platform-key flag (ADR-5, Q2 pending: ships OFF)", () => {
  const ON: PlatformKeyConfig = { enabled: true, runsPerUserPerDay: 2, maxPromptUsdPerToken: 0.0000005, key: PLATFORM_KEY };

  it("flag off + no key → 422 model_key_required; OpenRouter is not called", async () => {
    const f = ok();
    await start(f);
    expect(await evaluate(dfl(), CHEAP, {})).toMatchObject({ status: 422, body: { code: "model_key_required" } });
    expect(f).not.toHaveBeenCalled();
    expect(store.runs).toHaveLength(0);
  });

  it("flag on + no key → a platform run on a cheap model, sealed with the platform key; at most N per day, then 429", async () => {
    const f = ok();
    await start(f, ON);
    const token = dfl();
    const first = await evaluate(token, CHEAP, {});
    expect(first.status).toBe(202);
    expect(f).not.toHaveBeenCalled();
    expect(store.evaluations[0]!.priceSource).toBe("platform_key");
    expect(decryptRunKey(store.runKeys.get(store.runs[0]!.id)!, SECRET)).toBe(PLATFORM_KEY);
    expect((await evaluate(token, CHEAP, {})).status).toBe(202);
    const third = await evaluate(token, CHEAP, {});
    expect(third).toMatchObject({ status: 429, body: { code: "platform_quota_exceeded" } });
    expect(third.text).not.toContain(PLATFORM_KEY);
    expect(store.runs).toHaveLength(2);
    // The quota is per principal, and BYOK runs never count against it.
    expect((await evaluate(token, CHEAP)).status).toBe(202);
    expect((await evaluate(dfl(), CHEAP, {})).status).toBe(202);
  });

  it("a two-task evaluation that would pass the daily platform quota → 429, nothing written", async () => {
    await start(ok(), { ...ON, runsPerUserPerDay: 1 });
    const res = await call("/evaluations", dfl(), { agentId: agents[CHEAP], taskIds: ["webhook-ledger", "rate-limiter"] });
    expect(res).toMatchObject({ status: 429, body: { code: "platform_quota_exceeded" } });
    expect(store.runs).toHaveLength(0);
  });

  it("flag on + no key + an expensive or unpriced (opencode-go) model → 422 platform_model_not_allowed", async () => {
    await start(ok(), ON);
    expect(await evaluate(dfl(), PRICEY, {})).toMatchObject({ status: 422, body: { code: "platform_model_not_allowed" } });
    expect(await evaluate(dfl(), GO, {})).toMatchObject({ status: 422, body: { code: "platform_model_not_allowed" } });
    expect(store.runs).toHaveLength(0);
  });

  it("flag on + no platform key configured → 503 platform_key_not_configured", async () => {
    await start(ok(), { ...ON, key: null });
    expect(await evaluate(dfl(), CHEAP, {})).toMatchObject({ status: 503, body: { code: "platform_key_not_configured" } });
  });

  it("flag on + a user key → the BYOK path (probed), not the platform key", async () => {
    const f = ok();
    await start(f, ON);
    expect((await evaluate(dfl(), PRICEY)).status).toBe(202);
    expect(f).toHaveBeenCalledTimes(1);
    expect(decryptRunKey(store.runKeys.get(store.runs[0]!.id)!, SECRET)).toBe(KEY);
  });
});

describe("POST /models/access", () => {
  it("200 {label, limitRemaining, isFreeTier}; never stores the key", async () => {
    await start(ok());
    const res = await call("/models/access", dfl(), { openrouterKey: KEY });
    expect(res).toMatchObject({ status: 200, body: { label: "sk-or-v1-abc...", limitRemaining: 9.5, isFreeTier: false } });
    expect(res.text).not.toContain(FRAGMENT);
    expect(store.runKeys.size).toBe(0);
    expect(store.evaluations).toHaveLength(0);
  });

  it("works for a SIWS principal too (the web3 client's api.modelAccess)", async () => {
    await start(ok());
    const siws = issueSessionToken(OWNER, Date.now(), "siws").token;
    expect((await call("/models/access", siws, { openrouterKey: KEY })).status).toBe(200);
  });

  it("401 without a session; 422 required / invalid format / refused / no credit; 503 with Retry-After", async () => {
    await start(ok());
    const res = await fetch(`${base}/models/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ openrouterKey: KEY }) });
    expect(res.status).toBe(401);
    expect(await call("/models/access", dfl(), {})).toMatchObject({ status: 422, body: { code: "model_key_required" } });
    expect(await call("/models/access", dfl(), { openrouterKey: "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx" })).toMatchObject({ status: 422, body: { code: "model_key_invalid" } });
    await new Promise<void>((r) => server!.close(() => r()));

    await start(vi.fn<typeof fetch>(async () => json(403, {})));
    expect(await call("/models/access", dfl(), { openrouterKey: KEY })).toMatchObject({ status: 422, body: { code: "model_key_invalid" } });
    await new Promise<void>((r) => server!.close(() => r()));

    await start(vi.fn<typeof fetch>(async () => json(200, { data: { label: "k", limit_remaining: 0 } })));
    expect(await call("/models/access", dfl(), { openrouterKey: KEY })).toMatchObject({ status: 422, body: { code: "model_key_no_credit" } });
    await new Promise<void>((r) => server!.close(() => r()));

    await start(vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("fetch failed"))));
    const down = await call("/models/access", dfl(), { openrouterKey: KEY });
    expect(down).toMatchObject({ status: 503, body: { code: "model_key_probe_unavailable" } });
    expect(down.headers.get("retry-after")).toBe("30");
  });
});
