import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { FakeRunsStore } from "../domain/runs-store.fake.js";
import type { EvidenceManifest } from "../domain/grader.js";
import { issueSessionToken } from "../http/auth.js";
import { proofNonceSeed } from "../chain/attestation.js";
import { usdToLamports, lamportsToSol, type EvaluationsConfig } from "./config.js";
import { createEvaluationIssuer } from "./issuer.js";
import { buildEvaluationMemo, parseEvaluationMemo } from "./memo.js";
import { coinGeckoSolUsd, parsePriceUpdateV2, pythOnChainSolUsd, PYTH_RECEIVER_PROGRAM, pythSolUsd, solUsdProvider, PYTH_SOL_USD_FEED_ID, type SolUsdQuote } from "./price.js";
import { rollup } from "./rollup.js";
import { ceilCents, priceRun, type RunCostEstimator } from "./estimate.js";
import type { PaymentGateway, TransferFields, VerifyResult } from "./solana-pay.js";
import { FakeEvaluationsStore } from "./store.fake.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TREASURY = "GZTkDGqnELbVMrnpq5rK8yizzJ5JpMxrTzdKyitrgWWp";

const manifest = (hiddenPassed: number, total = 85): EvidenceManifest => ({
  schema_version: "1",
  evaluator_version: "0.1.0",
  scenario_id: "webhook-ledger",
  generated_at: "2026-10-12T00:00:00Z",
  fixture_hash: "f".repeat(64),
  patch_hash: "p".repeat(64),
  patch_scope: { changed_files: ["src/ledger.ts"], allowed: true },
  tests: {
    public_baseline: { total: 4, passed: 1, failed: 3 },
    public_after_patch: { total: 4, passed: 4, failed: 0 },
    hidden: { total: 6, passed: hiddenPassed, failed: 6 - hiddenPassed },
  },
  score: { public_behavior: 30, hidden_behavior: 25, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5, total },
  errors: [],
});

const config: EvaluationsConfig = {
  baseFeeUsd: 0.1,
  fallbackPriceUsd: 0.2,
  quoteTtlMs: 120_000,
  quoteGraceMs: 15_000,
  treasury: TREASURY,
  runsPerWalletPerDay: 30,
  maxTasks: 9,
  webBaseUrl: "https://web.example",
};

class FakeGateway implements PaymentGateway {
  /** txSig → what the chain shows. */
  txs = new Map<string, { lamports: number; reference: string; memo: string; recipient: string; blockTimeMs: number }>();
  newReference() {
    return Keypair.generate().publicKey.toBase58();
  }
  transferUrl(f: TransferFields) {
    return `solana:${f.recipient}?amount=${lamportsToSol(f.lamports)}&reference=${f.reference}`;
  }
  async buildTransferTx() {
    return "AAAA";
  }
  async verify(f: TransferFields, txSig: string | null): Promise<VerifyResult> {
    const entry = txSig ? this.txs.get(txSig) : [...this.txs.entries()].find(([, t]) => t.reference === f.reference)?.[1];
    const sig = txSig ?? [...this.txs.entries()].find(([, t]) => t.reference === f.reference)?.[0];
    if (!entry || !sig) return { ok: false, code: "not_found", message: "not found" };
    if (entry.reference !== f.reference) return { ok: false, code: "invalid", message: "payment does not match the quote: invalid reference 0" };
    if (entry.lamports < f.lamports) return { ok: false, code: "invalid", message: "payment does not match the quote: amount not transferred" };
    if (entry.memo !== f.memo) return { ok: false, code: "invalid", message: "payment does not match the quote: invalid memo" };
    return { ok: true, txSig: sig, payer: OWNER, blockTimeMs: entry.blockTimeMs };
  }
}

let server: Server;
let base: string;
let store: FakeEvaluationsStore;
let gateway: FakeGateway;
let clock: number;
let price: () => Promise<SolUsdQuote>;
let agentId: string;
let estimate: RunCostEstimator;

const auth = (w: string) => ({ Authorization: `Bearer ${issueSessionToken(w).token}`, "Content-Type": "application/json" });
const sig = () => Keypair.generate().publicKey.toBase58() + "x".repeat(20);

async function post(path: string, body: unknown, wallet = OWNER) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: auth(wallet), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
async function get(path: string, wallet = OWNER) {
  const res = await fetch(`${base}${path}`, { headers: auth(wallet) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeEach(async () => {
  store = new FakeEvaluationsStore();
  gateway = new FakeGateway();
  clock = Date.parse("2026-10-12T16:00:00Z");
  price = async () => ({ solUsdRate: 108.98, priceSource: "pyth", publishedAt: new Date(clock).toISOString() });
  agentId = randomUUID();
  estimate = async () => ({ costUsd: 0.0123, basis: "history", sampleSize: 3 });
  store.agents.push({ id: agentId, ownerWallet: OWNER, name: "Settle Wise", slug: "settlewise", repoFullName: "acme/agent", agentPath: ".", model: "qwen/qwen3-coder", modelRelease: null, visibility: "listed", pinnedCommit: null });
  store.versions.push({ id: randomUUID(), agentId, commitSha: "9f2c1ab0".padEnd(40, "0") });
  store.tasks.push(
    { taskId: "webhook-ledger", taskVersionId: null, slug: "webhook-ledger", name: "Webhook ledger", packId: "webhook-ledger", packVersion: "1", isPublic: true, runnable: true },
    { taskId: "rate-limiter", taskVersionId: null, slug: "rate-limiter", name: "Rate limiter", packId: "", packVersion: "", isPublic: true, runnable: false },
  );
  server = createApp(new FakeRepository(), {
    evaluations: { store, config, price: () => price(), payments: gateway, runKeySecret: "k".repeat(48), now: () => clock, estimate: (pack, version, model) => estimate(pack, version, model) },
  }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function quoteAndPay(lamportsDelta = 0, taskIds = ["webhook-ledger"]) {
  const q = await post("/evaluations/quote", { agentId, taskIds });
  expect(q.status).toBe(201);
  const txSig = sig();
  gateway.txs.set(txSig, { lamports: q.body.amountLamports + lamportsDelta, reference: q.body.reference, memo: q.body.memo, recipient: TREASURY, blockTimeMs: clock + 5_000 });
  return { q: q.body, txSig };
}

describe("POST /evaluations/quote", () => {
  it("charges the forecast: model cost estimate + base fee, rounded up to the cent; itemized; priceSource and solUsdRate recorded; ids pre-allocated in the Memo", async () => {
    const q = await post("/evaluations/quote", { agentId, taskIds: ["webhook-ledger"] });
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({
      modelCostEstimateUsd: 0.0123, baseFeeUsd: 0.1, totalUsd: 0.12, solUsd: 108.98, priceSource: "pyth",
      priceUsdPerRun: 0.12, amountUsd: 0.12, solUsdRate: 108.98, treasury: TREASURY,
    });
    expect(q.body.tasks[0]).toMatchObject({ modelCostEstimateUsd: 0.0123, baseFeeUsd: 0.1, priceUsd: 0.12, estimateBasis: "history" });
    expect(q.body.totalLamports).toBe(usdToLamports(0.12, 108.98));
    expect(q.body.amountLamports).toBe(q.body.totalLamports);
    expect(Date.parse(q.body.expiresAt) - clock).toBe(120_000);
    const memo = parseEvaluationMemo(q.body.memo)!;
    expect(memo.evaluationId).toBe(q.body.evaluationId);
    expect(memo.runIds).toEqual(q.body.runIds);
    expect(store.payments[0]).toMatchObject({ priceSource: "pyth", solUsdRate: 108.98, status: "pending" });
  });

  it("falls back to a flat US$0.20 per run when no estimate exists", async () => {
    estimate = async () => null;
    const q = await post("/evaluations/quote", { agentId, taskIds: ["webhook-ledger"] });
    expect(q.body).toMatchObject({ totalUsd: 0.2, modelCostEstimateUsd: 0, baseFeeUsd: 0.2 });
    expect(q.body.tasks[0]).toMatchObject({ priceUsd: 0.2, estimateBasis: "fallback", modelCostEstimateUsd: null });
    expect(priceRun(null, 0.1, 0.2).priceUsd).toBe(0.2);
    expect(ceilCents(0.1 + 0.02)).toBe(0.12);
    expect(ceilCents(0.10001)).toBe(0.11);
  });

  it("answers 503 when both price feeds are down", async () => {
    const down = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    price = solUsdProvider(down);
    const q = await post("/evaluations/quote", { agentId, taskIds: ["webhook-ledger"] });
    expect(q.status).toBe(503);
    expect(q.body.error).toMatch(/SOL\/USD price unavailable/);
    expect(down).toHaveBeenCalledTimes(3);
  });

  it("refuses a task that is not runnable, an unknown agent, a private agent of another wallet, and the daily limit", async () => {
    expect((await post("/evaluations/quote", { agentId, taskIds: ["rate-limiter"] })).status).toBe(409);
    expect((await post("/evaluations/quote", { agentId: randomUUID(), taskIds: ["webhook-ledger"] })).status).toBe(404);
    store.agents[0]!.visibility = "private";
    expect((await post("/evaluations/quote", { agentId, taskIds: ["webhook-ledger"] }, OTHER)).status).toBe(404);
    store.agents[0]!.visibility = "listed";
    store.recentRuns = 30;
    expect((await post("/evaluations/quote", { agentId, taskIds: ["webhook-ledger"] })).status).toBe(429);
  });
});

describe("POST /evaluations", () => {
  it("queues the runs only after the transfer validates, with run_start_sig = the payment tx", async () => {
    const { q, txSig } = await quoteAndPay();
    const res = await post("/evaluations", { reference: q.reference, txSig });
    expect(res.status).toBe(202);
    expect(res.body.evaluationId).toBe(q.evaluationId);
    expect(res.body.runs).toEqual([{ runId: q.runIds[0], taskId: "webhook-ledger", seq: 1 }]);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ status: "queued", runStartSig: txSig, evaluationId: q.evaluationId });
    expect(store.payments[0]).toMatchObject({ status: "confirmed", txSig });
    expect(store.keys.get(q.evaluationId)).toBeNull(); // Gate Q2: ITERA pays the tokens, no key.
  });

  it("is idempotent on txSig: a second POST returns the same evaluationId and queues nothing more", async () => {
    const { q, txSig } = await quoteAndPay();
    const first = await post("/evaluations", { reference: q.reference, txSig });
    const second = await post("/evaluations", { reference: q.reference, txSig });
    const third = await post("/evaluations", { txSig });
    expect(second.status).toBe(200);
    expect(second.body.evaluationId).toBe(first.body.evaluationId);
    expect(third.body.evaluationId).toBe(first.body.evaluationId);
    expect(store.runs).toHaveLength(1);
  });

  it("answers 402 on a wrong amount, 402 quote expired after the window, 402 when nothing is on chain yet", async () => {
    const { q, txSig } = await quoteAndPay(-1);
    const wrong = await post("/evaluations", { reference: q.reference, txSig });
    expect(wrong.status).toBe(402);
    expect(wrong.body.code).toBe("wrong_amount");

    const q2 = (await post("/evaluations/quote", { agentId, taskIds: ["webhook-ledger"] })).body;
    expect((await post("/evaluations", { reference: q2.reference })).body.code).toBe("payment_not_found");
    clock += 140_000;
    const expired = await post("/evaluations", { reference: q2.reference });
    expect(expired.status).toBe(402);
    expect(expired.body.error).toBe("quote expired");
    expect(store.runs).toHaveLength(0);
  });

  it("answers 402 quote expired when the transfer landed after the window", async () => {
    const { q, txSig } = await quoteAndPay();
    gateway.txs.get(txSig)!.blockTimeMs = clock + 200_000;
    const res = await post("/evaluations", { reference: q.reference, txSig });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("quote_expired");
  });

  it("refuses another wallet's quote, and one tx paying two quotes", async () => {
    const { q, txSig } = await quoteAndPay();
    expect((await post("/evaluations", { reference: q.reference, txSig }, OTHER)).status).toBe(403);
    await post("/evaluations", { reference: q.reference, txSig });
    const q2 = (await post("/evaluations/quote", { agentId, taskIds: ["webhook-ledger"] })).body;
    expect((await post("/evaluations", { reference: q2.reference, txSig })).status).toBe(409);
  });

  it("lets the legacy vendor body fall through", async () => {
    const res = await fetch(`${base}/evaluations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: "x" }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/vendor.displayName/);
  });
});

describe("GET /evaluations/:id, cancel, list", () => {
  async function paid(taskIds = ["webhook-ledger"]) {
    const { q, txSig } = await quoteAndPay(0, taskIds);
    await post("/evaluations", { reference: q.reference, txSig });
    return q.evaluationId as string;
  }

  it("moves queued → running → issuing → issued", async () => {
    const id = await paid();
    expect((await get(`/evaluations/${id}`)).body.uiState).toBe("queued");
    const run = store.runs[0]!;
    Object.assign(run, { status: "running", phase: "agent_running", claimedAt: new Date(clock + 1000).toISOString() });
    let v = (await get(`/evaluations/${id}`)).body;
    expect(v.uiState).toBe("running");
    expect(v.tasks[0].stage).toBe("awaiting_artifact");
    Object.assign(run, { status: "pass", phase: "done", scoreTotal: 85, evidenceManifest: manifest(6), completedAt: new Date(clock + 60_000).toISOString() });
    v = (await get(`/evaluations/${id}`)).body;
    expect(v.uiState).toBe("issuing");
    expect(v.tasks[0]).toMatchObject({ outcome: "PASS", score: 85, testsPassed: 6, testsTotal: 6, durationMs: 59_000 });
    store.proofs.push({ runId: run.id, status: "confirmed", manifestSha256: "a".repeat(64), nftMint: "Mint1", txSig: "Tx1", attestationAddress: "Att1", error: null, createdAt: new Date(clock + 70_000).toISOString() });
    v = (await get(`/evaluations/${id}`)).body;
    expect(v.uiState).toBe("issued");
    expect(v.status).toBe("issued");
    expect(v.score).toBe(85);
    expect(v.slug).toMatch(/^settlewise-[0-9a-f]{4}$/);
    expect(v.shareUrl).toBe(`https://web.example/e/${v.slug}`);
    expect(v.events.map((e: { label: string }) => e.label)).toContain("Payment confirmed");
  });

  it("a timeout yields uiState error and outcome INVALID", async () => {
    const id = await paid();
    Object.assign(store.runs[0]!, { status: "timeout", completedAt: new Date(clock + 1000).toISOString() });
    const v = (await get(`/evaluations/${id}`)).body;
    expect(v.uiState).toBe("error");
    expect(v.tasks[0]).toMatchObject({ outcome: "INVALID", stage: "timed_out" });
  });

  it("cancel moves queued runs to cancelled; the owner only", async () => {
    const id = await paid();
    expect((await post(`/evaluations/${id}/cancel`, {}, OTHER)).status).toBe(404);
    const res = await post(`/evaluations/${id}/cancel`, {});
    expect(res.body).toMatchObject({ status: "cancelled", cancelledRuns: 1, refund: null });
    expect(store.runs[0]!.status).toBe("cancelled");
    expect((await get(`/evaluations/${id}`)).body.uiState).toBe("cancelled");
  });

  it("lists with scopes and totals", async () => {
    await paid();
    const otherAgent = randomUUID();
    store.agents.push({ ...store.agents[0]!, id: otherAgent, ownerWallet: OTHER, name: "Other Bot", slug: "other-bot" });
    store.versions.push({ id: randomUUID(), agentId: otherAgent, commitSha: "b".repeat(40) });
    const q = (await post("/evaluations/quote", { agentId: otherAgent, taskIds: ["webhook-ledger"] })).body;
    const txSig = sig();
    gateway.txs.set(txSig, { lamports: q.amountLamports, reference: q.reference, memo: q.memo, recipient: TREASURY, blockTimeMs: clock });
    await post("/evaluations", { reference: q.reference, txSig });

    const all = (await get("/evaluations?scope=all")).body;
    expect(all.evaluations).toHaveLength(2);
    expect(all.totals.counts).toEqual({ all: 2, myAgents: 1, others: 1 });
    expect(all.totals.spentLamports).toBe(2 * usdToLamports(0.12, 108.98));
    expect((await get("/evaluations?scope=my_agents")).body.evaluations.map((e: any) => e.agent.name)).toEqual(["Settle Wise"]);
    expect((await get("/evaluations?scope=others")).body.evaluations.map((e: any) => e.agent.name)).toEqual(["Other Bot"]);
    expect((await get("/evaluations?scope=nope")).status).toBe(400);
  });
});

describe("evaluation-issuer", () => {
  it("gives an infra_error run one free retry, then issues the proof with the v2 nonce slot", async () => {
    const { q, txSig } = await quoteAndPay();
    await post("/evaluations", { reference: q.reference, txSig });
    const first = store.runs[0]!;
    Object.assign(first, { status: "infra_error", completedAt: new Date(clock).toISOString() });

    const runsStore = new FakeRunsStore();
    const issueProof = vi.fn(async (input: any) => ({ proofHash: "h", status: "confirmed" as const, nftMint: "M", txSig: "T" }));
    const issuer = createEvaluationIssuer({ store, runs: runsStore, proofIssuer: { issueProof }, log: () => undefined, now: () => clock });

    await issuer.tick();
    expect(store.runs).toHaveLength(2);
    const retry = store.runs[1]!;
    expect(retry).toMatchObject({ retryOfRunId: first.id, status: "queued", runStartSig: txSig, seq: 2 });
    expect(store.evaluations[0]!.status).toBe("in_progress");
    await issuer.tick();
    expect(store.runs).toHaveLength(2); // once only

    Object.assign(retry, { status: "pass", scoreTotal: 90, evidenceManifest: manifest(6, 90), completedAt: new Date(clock + 1000).toISOString() });
    runsStore.runs.push({ id: retry.id, ownerWallet: OWNER, agentId, agentVersionId: null, taskPackId: "webhook-ledger", taskPackVersion: "1", status: "pass", phase: "done", runStartSig: txSig, evidenceManifest: retry.evidenceManifest, scoreTotal: 90, error: null, startedAt: retry.startedAt, completedAt: retry.completedAt });
    await issuer.tick();
    expect(issueProof).toHaveBeenCalledTimes(1);
    const arg = issueProof.mock.calls[0]![0];
    expect(arg.run).toMatchObject({ id: retry.id, evaluationId: q.evaluationId, retryOfRunId: first.id });
    store.proofs.push({ runId: retry.id, status: "confirmed", manifestSha256: "c".repeat(64), nftMint: "M", txSig: "T", attestationAddress: "A", error: null, createdAt: new Date().toISOString() });
    await issuer.tick();
    expect(store.evaluations[0]).toMatchObject({ status: "issued", score: 90, passCount: 1 });
    expect(store.evaluations[0]!.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    // The retry's proof is bound to the slot named in the Memo.
    expect(proofNonceSeed(txSig, arg.run.retryOfRunId)).toBe(`${txSig}:${first.id}`);
    expect(parseEvaluationMemo(q.memo)!.runIds).toContain(first.id);
  });
});

describe("price feeds", () => {
  it("reads the Pyth SOL/USD PriceUpdateV2 account on Solana (owner, feed id, freshness)", async () => {
    const now = Date.parse("2026-10-12T16:00:00Z");
    const data = Buffer.alloc(134);
    data[40] = 1; // Full verification
    Buffer.from(PYTH_SOL_USD_FEED_ID, "hex").copy(data, 41);
    data.writeBigInt64LE(10_899_115_697n, 73);
    data.writeInt32LE(-8, 89);
    data.writeBigInt64LE(BigInt(now / 1000 - 10), 93);
    expect(parsePriceUpdateV2(data)).toMatchObject({ feedId: PYTH_SOL_USD_FEED_ID, fullyVerified: true });
    const rpc = (owner: string) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { value: { owner, data: [data.toString("base64"), "base64"] } } }) }));
    expect(await pythOnChainSolUsd(rpc(PYTH_RECEIVER_PROGRAM), now)).toMatchObject({ solUsdRate: 108.991157, priceSource: "pyth" });
    await expect(pythOnChainSolUsd(rpc("11111111111111111111111111111111"), now)).rejects.toThrow(/receiver/);
    await expect(pythOnChainSolUsd(rpc(PYTH_RECEIVER_PROGRAM), now + 600_000)).rejects.toThrow(/stale/);
  });

  it("reads Pyth Hermes (price × 10^expo) and refuses a stale price", async () => {
    const now = Date.parse("2026-10-12T16:00:00Z");
    const body = { parsed: [{ id: PYTH_SOL_USD_FEED_ID, price: { price: "10898000000", expo: -8, publish_time: now / 1000 - 5 } }] };
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
    expect(await pythSolUsd(f, now)).toMatchObject({ solUsdRate: 108.98, priceSource: "pyth" });
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain(`ids[]=0x${PYTH_SOL_USD_FEED_ID}`);
    await expect(pythSolUsd(f, now + 600_000)).rejects.toThrow(/stale/);
  });

  it("falls back to CoinGecko when Pyth fails", async () => {
    const f = vi.fn(async (url: string) =>
      !url.includes("coingecko") ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ solana: { usd: 110.5 } }) },
    );
    expect(await solUsdProvider(f)()).toMatchObject({ solUsdRate: 110.5, priceSource: "coingecko" });
    expect(await coinGeckoSolUsd(f)).toMatchObject({ priceSource: "coingecko" });
  });
});

describe("memo", () => {
  it("fits the payment tx (Memo + transfer + reference) under 1232 bytes with the max of 9 tasks", () => {
    const payer = Keypair.generate().publicKey;
    const ids = Array.from({ length: 9 }, () => randomUUID());
    const memo = buildEvaluationMemo({ evaluationId: randomUUID(), runIds: ids, agentRepo: "some-org/some-fairly-long-agent-repo", agentCommit: "a".repeat(40), modelId: "anthropic/claude-sonnet-4.5", tasks: ids.map((_, i) => `a-long-task-slug-${i}@12`) });
    const transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(TREASURY), lamports: 8_000_000 });
    transfer.keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false });
    const tx = new Transaction({ feePayer: payer, recentBlockhash: Keypair.generate().publicKey.toBase58() })
      .add(new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from(memo, "utf8") }))
      .add(transfer);
    const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    expect(size).toBeLessThanOrEqual(1232);
    expect(parseEvaluationMemo(memo)!.runIds).toEqual(ids);
  });
});

describe("rollup", () => {
  it("scores the mean of PASS and FAIL runs, excluding INVALID (ADR-5)", () => {
    const ev = store.evaluations[0];
    expect(ev).toBeUndefined();
    const evaluation = {
      id: randomUUID(), slug: null, shortId: "abc", ownerWallet: OWNER, agentId, agentVersionId: "v", modelId: "m", modelRelease: null,
      tasks: [], status: "pending" as const, taskCount: 3, priceUsdPerRun: 0.1, feeUsd: 0.3, feeLamports: 1, solUsdRate: 1, priceSource: "pyth",
      paymentId: null, txSig: null, score: null, passCount: 0, failCount: 0, invalidCount: 0, testsPassed: 0, testsTotal: 0, manifestSha256: null,
      isPublic: true, freeRetriesUsed: 0, createdAt: new Date(clock).toISOString(), startedAt: null, completedAt: null, issuedAt: null, cancelledAt: null,
    };
    const r = (seq: number, status: any, score: number | null, m: unknown = null) => ({
      id: randomUUID(), evaluationId: evaluation.id, seq, taskId: `t${seq}`, taskVersionId: null, status, phase: "done" as const, scoreTotal: score,
      evidenceManifest: m, runStartSig: "S", error: null, retryOfRunId: null, startedAt: evaluation.createdAt, claimedAt: null, completedAt: evaluation.createdAt,
    });
    const out = rollup({ evaluation, runs: [r(1, "pass", 90, manifest(6, 90)), r(2, "fail", 40, manifest(2, 40)), r(3, "invalid", 0, manifest(0, 0))], proofs: [], agent: { name: "A", slug: null, repoFullName: null }, agentCommit: null, nowMs: clock });
    expect(out.view.score).toBe(65);
    expect(out.view.counts).toMatchObject({ pass: 1, fail: 1, invalid: 1 });
    expect(out.columns.status).toBe("issuing");
  });
});
