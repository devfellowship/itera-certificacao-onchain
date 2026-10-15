import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { FakeRepository } from "../../domain/repository.fake.js";
import { issueSessionToken } from "../../auth/session.js";
import type { EvaluationsConfig } from "../../evaluations/config.js";
import type { EvalRun } from "../../evaluations/store.js";
import { FakeEvaluationsStore } from "../../evaluations/store.fake.js";
import { AFTER_GRADED, createPaymentAdapters, PAYMENT_KIND_BY_PRINCIPAL, paymentAdapterFor, paymentKindOf } from "./index.js";
import { sealModelApiKey } from "./model-key.js";
import type { PaymentGateway } from "./solana-pay-gateway.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const REFERENCE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const config: EvaluationsConfig = {
  baseFeeUsd: 0.1,
  fallbackPriceUsd: 0.2,
  quoteTtlMs: 120_000,
  quoteGraceMs: 15_000,
  treasury: "GZTkDGqnELbVMrnpq5rK8yizzJ5JpMxrTzdKyitrgWWp",
  runsPerWalletPerDay: 30,
  maxTasks: 9,
  webBaseUrl: "https://web.example",
};

function spyGateway() {
  return {
    newReference: vi.fn(() => REFERENCE),
    transferUrl: vi.fn(() => "solana:x"),
    buildTransferTx: vi.fn(async () => "AAAA"),
    verify: vi.fn(async () => ({ ok: false as const, code: "not_found" as const, message: "not found" })),
  } satisfies PaymentGateway;
}

describe("payment adapter selection (ADR-6)", () => {
  it("maps siws to solana_pay and dfl to free_byok", () => {
    expect(PAYMENT_KIND_BY_PRINCIPAL).toEqual({ siws: "solana_pay", dfl: "free_byok" });
    const adapters = createPaymentAdapters({ store: new FakeEvaluationsStore(), config, price: async () => ({ solUsdRate: 100, priceSource: "pyth", publishedAt: "" }), payments: spyGateway(), now: Date.now });
    expect(paymentAdapterFor(adapters, "siws").kind).toBe("solana_pay");
    expect(paymentAdapterFor(adapters, "dfl").kind).toBe("free_byok");
  });

  it("reads every stored evaluation as solana_pay until the payment_kind column exists", () => {
    expect(paymentKindOf({})).toBe("solana_pay");
    expect(paymentKindOf({ paymentKind: null })).toBe("solana_pay");
    expect(paymentKindOf({ paymentKind: "free_byok" })).toBe("free_byok");
  });

  it("afterGraded issues the proof for solana_pay and nothing for free_byok", async () => {
    const ctx = () => ({ evaluationId: randomUUID(), run: { id: randomUUID() } as EvalRun, proof: undefined, issueProof: vi.fn(async () => undefined) });
    const paid = ctx();
    await AFTER_GRADED.solana_pay(paid);
    expect(paid.issueProof).toHaveBeenCalledTimes(1);
    const free = ctx();
    await AFTER_GRADED.free_byok(free);
    expect(free.issueProof).not.toHaveBeenCalled();
  });
});

describe("sealModelApiKey", () => {
  it("keeps the router's BYOK rules", () => {
    expect(sealModelApiKey(undefined, "k".repeat(48))).toEqual({ ok: true, modelApiKeyEnc: null });
    expect(sealModelApiKey("", undefined)).toEqual({ ok: true, modelApiKeyEnc: null });
    expect(sealModelApiKey("x", "k".repeat(48))).toEqual({ ok: false, outcome: { status: 400, body: { error: "modelApiKey is not a plausible API key" } } });
    const sealed = sealModelApiKey("sk-or-v1-" + "a".repeat(40), "k".repeat(48));
    expect(sealed.ok && typeof sealed.modelApiKeyEnc === "string" && !sealed.modelApiKeyEnc.includes("aaaa")).toBe(true);
  });
});

describe("evaluation routes by principal kind", () => {
  let server: Server;
  let base: string;
  let store: FakeEvaluationsStore;
  let gateway: ReturnType<typeof spyGateway>;
  let agentId: string;

  beforeEach(async () => {
    store = new FakeEvaluationsStore();
    gateway = spyGateway();
    agentId = randomUUID();
    store.agents.push({ id: agentId, ownerWallet: WALLET, name: "Settle Wise", slug: "settlewise", repoFullName: "acme/agent", agentPath: ".", model: "qwen/qwen3-coder", modelRelease: null, visibility: "listed", pinnedCommit: null });
    store.versions.push({ id: randomUUID(), agentId, commitSha: "9f2c1ab0".padEnd(40, "0") });
    store.tasks.push({ taskId: "webhook-ledger", taskVersionId: null, slug: "webhook-ledger", name: "Webhook ledger", packId: "webhook-ledger", packVersion: "1", isPublic: true, runnable: true });
    server = createApp(new FakeRepository(), {
      evaluations: { store, config, price: async () => ({ solUsdRate: 100, priceSource: "pyth", publishedAt: new Date().toISOString() }), payments: gateway, runKeySecret: "k".repeat(48) },
    }).listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function post(path: string, body: unknown, token: string) {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const dflToken = () => issueSessionToken(`dfl:${randomUUID()}`, Date.now(), "dfl").token;
  const siwsToken = () => issueSessionToken(WALLET, Date.now(), "siws").token;

  it("a dfl principal never reaches the Solana path: zero quote, no payment transaction", async () => {
    const token = dflToken();
    const quote = await post("/evaluations/quote", { agentId, taskIds: ["webhook-ledger"] }, token);
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ paymentKind: "free_byok", totalUsd: 0, totalLamports: 0, modelKeyRequired: true });
    const tx = await post(`/evaluations/quote/${REFERENCE}/transaction`, {}, token);
    expect(tx).toEqual({ status: 409, body: { error: "the free evaluation path has no payment transaction", code: "no_payment" } });
    const settle = await post("/evaluations", { reference: REFERENCE }, token);
    expect(settle.status).toBe(400);

    expect(gateway.newReference).not.toHaveBeenCalled();
    expect(gateway.transferUrl).not.toHaveBeenCalled();
    expect(gateway.buildTransferTx).not.toHaveBeenCalled();
    expect(gateway.verify).not.toHaveBeenCalled();
    expect(store.payments).toHaveLength(0);
  });

  it("a siws principal still gets the Solana Pay quote", async () => {
    const quote = await post("/evaluations/quote", { agentId, taskIds: ["webhook-ledger"] }, siwsToken());
    expect(quote.status).toBe(201);
    expect(quote.body.reference).toBe(REFERENCE);
    expect(quote.body.transferUrl).toBe("solana:x");
    expect(gateway.newReference).toHaveBeenCalledTimes(1);
  });

  it("a dfl principal keeps the legacy body fall-through on POST /evaluations", async () => {
    const res = await post("/evaluations", { idempotencyKey: "x" }, dflToken());
    expect(res.status).not.toBe(501);
  });
});
