/**
 * The free BYOK evaluation path (plan 20261015-testmyagent-web2-client, T7): `POST /evaluations`
 * for a DFL principal, the abuse floor, the `graded` terminal state, and the web3 path unchanged.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { validateApiResponse } from "@itera/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { issueSessionToken } from "../auth/session.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { decryptRunKey } from "../domain/run-key.js";
import { FakeRunsStore } from "../domain/runs-store.fake.js";
import type { EvidenceManifest } from "../domain/evidence-manifest.js";
import type { ModelKeyProbe } from "../payments/adapters/free-byok.js";
import type { PaymentGateway } from "../payments/adapters/solana-pay-gateway.js";
import type { EvaluationsConfig } from "./config.js";
import { createEvaluationIssuer } from "./issuer.js";
import { FakeEvaluationsStore } from "./store.fake.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SECRET = "k".repeat(48);
const KEY = "sk-or-v1-" + "a".repeat(40);
const LEDGER_CONTRACT = JSON.parse(readFileSync(new URL("../../../../benchmarks/webhook-ledger/task.json", import.meta.url), "utf-8"));
const config: EvaluationsConfig = {
  baseFeeUsd: 0.1,
  fallbackPriceUsd: 0.2,
  quoteTtlMs: 120_000,
  quoteGraceMs: 15_000,
  treasury: "GZTkDGqnELbVMrnpq5rK8yizzJ5JpMxrTzdKyitrgWWp",
  runsPerWalletPerDay: 30,
  maxTasks: 9,
  webBaseUrl: "https://web.example",
  maxQueuedRunsPerUser: 3,
};

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

let server: Server;
let base: string;
let store: FakeEvaluationsStore;
let gateway: PaymentGateway & { verify: ReturnType<typeof vi.fn> };
let probe: ReturnType<typeof vi.fn<ModelKeyProbe>>;
let agentId: string;
let mcpAgentId: string;
let dfl: string;

const dflToken = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;
const siwsToken = () => issueSessionToken(WALLET, Date.now(), "siws").token;

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const freeBody = (extra: Record<string, unknown> = {}) => ({ agentId, taskIds: ["webhook-ledger"], modelApiKey: KEY, ...extra });

beforeEach(async () => {
  store = new FakeEvaluationsStore();
  gateway = {
    newReference: () => Keypair.generate().publicKey.toBase58(),
    transferUrl: () => "solana:x",
    buildTransferTx: async () => "AAAA",
    verify: vi.fn(async () => ({ ok: false as const, code: "not_found" as const, message: "not found" })),
  };
  probe = vi.fn<ModelKeyProbe>(async () => ({ ok: true }));
  agentId = randomUUID();
  mcpAgentId = randomUUID();
  dfl = `dfl:${randomUUID()}`;
  const agent = { ownerWallet: WALLET, name: "Settle Wise", slug: "settlewise", repoFullName: "acme/agent", agentPath: ".", model: "qwen/qwen3-coder", modelRelease: null, visibility: "listed" as const, pinnedCommit: null };
  store.agents.push({ ...agent, id: agentId, requires: [] }, { ...agent, id: mcpAgentId, requires: ["mcp:postgres"] });
  for (const id of [agentId, mcpAgentId]) store.versions.push({ id: randomUUID(), agentId: id, commitSha: "9f2c1ab0".padEnd(40, "0") });
  store.tasks.push(
    { taskId: "webhook-ledger", taskVersionId: null, slug: "webhook-ledger", name: "Webhook ledger", packId: "webhook-ledger", packVersion: "1", isPublic: true, runnable: true, contract: LEDGER_CONTRACT },
    { taskId: "rate-limiter", taskVersionId: null, slug: "rate-limiter", name: "Rate limiter", packId: "rate-limiter", packVersion: "1", isPublic: true, runnable: true, contract: LEDGER_CONTRACT },
  );
  server = createApp(new FakeRepository(), {
    evaluations: { store, config, price: async () => ({ solUsdRate: 100, priceSource: "pyth", publishedAt: new Date().toISOString() }), payments: gateway, runKeySecret: SECRET, probeModelKey: probe },
  }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("POST /evaluations — free BYOK path (dfl principal)", () => {
  it("202: one free_byok evaluation and N queued runs, each with the sealed key; no payment, no Solana call", async () => {
    const body = freeBody({ taskIds: ["webhook-ledger", "rate-limiter"], modelRelease: "2026-10" });
    expect(validateApiResponse("freeEvaluationRequest", body)).toMatchObject({ ok: true });
    const res = await call("POST", "/evaluations", dflToken(dfl), body);
    expect(res.status).toBe(202);
    expect(validateApiResponse("freeEvaluationCreated", res.body)).toMatchObject({ ok: true });
    expect(res.body).toMatchObject({ status: "pending", paymentKind: "free_byok" });
    expect(res.body.runs.map((r: any) => [r.taskId, r.seq])).toEqual([["webhook-ledger", 1], ["rate-limiter", 2]]);

    const ev = store.evaluations[0]!;
    expect(ev).toMatchObject({ id: res.body.evaluationId, paymentKind: "free_byok", ownerWallet: dfl, paymentId: null, feeLamports: 0, modelRelease: "2026-10", status: "pending" });
    const runs = await store.listRuns(ev.id);
    expect(runs.map((r) => r.id)).toEqual(res.body.runs.map((r: any) => r.id));
    for (const r of runs) {
      expect(r).toMatchObject({ status: "queued", runStartSig: null });
      const enc = store.runKeys.get(r.id)!;
      expect(enc).toMatch(/^v1\./);
      expect(enc).not.toContain(KEY);
      expect(decryptRunKey(enc, SECRET)).toBe(KEY);
    }
    expect(probe).toHaveBeenCalledWith(KEY);
    expect(store.payments).toHaveLength(0);
    expect(gateway.verify).not.toHaveBeenCalled();
  });

  it("422 model_key_required without a key, 422 model_key_invalid for a key that is not an OpenRouter key", async () => {
    const token = dflToken(dfl);
    expect(await call("POST", "/evaluations", token, freeBody({ modelApiKey: undefined }))).toMatchObject({ status: 422, body: { code: "model_key_required" } });
    expect(await call("POST", "/evaluations", token, freeBody({ modelApiKey: "" }))).toMatchObject({ status: 422, body: { code: "model_key_required" } });
    expect(await call("POST", "/evaluations", token, freeBody({ modelApiKey: "sk-ant-" + "a".repeat(40) }))).toMatchObject({ status: 422, body: { code: "model_key_invalid" } });
    expect(await call("POST", "/evaluations", token, freeBody({ modelApiKey: "sk-or-x" }))).toMatchObject({ status: 422, body: { code: "model_key_invalid" } });
    expect(store.evaluations).toHaveLength(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it("the probe seam (T8) refuses with its own code, and nothing is written", async () => {
    probe.mockResolvedValueOnce({ ok: false, code: "model_key_no_credit", message: "the key has no credit left" });
    const res = await call("POST", "/evaluations", dflToken(dfl), freeBody());
    expect(res).toEqual({ status: 422, body: { error: "the key has no credit left", code: "model_key_no_credit" } });
    expect(store.evaluations).toHaveLength(0);
    expect(store.runs).toHaveLength(0);
  });

  it("keeps the shared checks: 400 body, 404 agent, 422 incompatible pair", async () => {
    const token = dflToken(dfl);
    expect((await call("POST", "/evaluations", token, freeBody({ agentId: "nope" }))).status).toBe(400);
    expect((await call("POST", "/evaluations", token, freeBody({ agentId: randomUUID() }))).status).toBe(404);
    const incompatible = await call("POST", "/evaluations", token, freeBody({ agentId: mcpAgentId }));
    expect(incompatible).toMatchObject({ status: 422, body: { code: "incompatible" } });
    expect(store.evaluations).toHaveLength(0);
  });

  it("429 too_many_queued when the user already has 3 queued or running runs", async () => {
    const token = dflToken(dfl);
    expect((await call("POST", "/evaluations", token, freeBody({ taskIds: ["webhook-ledger", "rate-limiter"] }))).status).toBe(202);
    store.runs[0]!.status = "running";
    expect((await call("POST", "/evaluations", token, freeBody())).status).toBe(202);
    const refused = await call("POST", "/evaluations", token, freeBody());
    expect(refused).toMatchObject({ status: 429, body: { code: "too_many_queued" } });
    expect(store.evaluations).toHaveLength(2);
    // Another user is not affected.
    expect((await call("POST", "/evaluations", dflToken(`dfl:${randomUUID()}`), freeBody())).status).toBe(202);
    // A finished run frees a slot.
    store.runs[0]!.status = "pass";
    expect((await call("POST", "/evaluations", token, freeBody())).status).toBe(202);
  });

  it("the quote is zero: no SOL, no payment row", async () => {
    const q = await call("POST", "/evaluations/quote", dflToken(dfl), { agentId, taskIds: ["webhook-ledger"] });
    expect(q).toMatchObject({ status: 200, body: { paymentKind: "free_byok", totalUsd: 0, totalLamports: 0, taskCount: 1, modelKeyRequired: true } });
    expect(store.payments).toHaveLength(0);
  });
});

describe("the web3 path is unchanged (siws principal)", () => {
  it("402 when the quote is not paid", async () => {
    const token = siwsToken();
    const q = await call("POST", "/evaluations/quote", token, { agentId, taskIds: ["webhook-ledger"] });
    expect(q.status).toBe(201);
    const res = await call("POST", "/evaluations", token, { reference: q.body.reference });
    expect(res).toMatchObject({ status: 402, body: { code: "payment_not_found" } });
    expect(store.evaluations).toHaveLength(0);
  });

  it("a free-shaped body without a payment is refused, never queued", async () => {
    const res = await call("POST", "/evaluations", siwsToken(), freeBody());
    expect(res.status).toBe(400);
    expect(store.evaluations).toHaveLength(0);
  });
});

describe("free_byok roll-up and issuer", () => {
  it("ends at graded, with no proof; the issuer never calls the proof issuer; cancel is refused", async () => {
    const token = dflToken(dfl);
    const created = await call("POST", "/evaluations", token, freeBody());
    const id = created.body.evaluationId as string;
    const run = store.runs[0]!;
    Object.assign(run, { status: "pass", phase: "done", scoreTotal: 85, evidenceManifest: manifest(6), claimedAt: new Date().toISOString(), completedAt: new Date().toISOString() });

    const issueProof = vi.fn(async () => ({ proofHash: "h", status: "confirmed" as const, nftMint: "M", txSig: "T" }));
    const issuer = createEvaluationIssuer({ store, runs: new FakeRunsStore(), proofIssuer: { issueProof }, log: () => undefined });
    await issuer.tick();
    expect(issueProof).not.toHaveBeenCalled();
    expect(store.evaluations[0]).toMatchObject({ status: "graded", score: 85, passCount: 1, issuedAt: null });
    // The key is wiped once every run has ended.
    expect(store.keys.get(id)).toBeNull();
    // graded is terminal: the issuer job no longer lists it.
    expect(await store.listOpen()).not.toContain(id);

    const view = await call("GET", `/evaluations/${id}`, token);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: "graded", uiState: "graded", paymentKind: "free_byok", proofs: [], shareUrl: null });
    expect(view.body.stages.map((s: any) => s.key)).not.toContain("attestation");
    expect(view.body.events[0]).toMatchObject({ label: "Evaluation queued" });
    expect(validateApiResponse("evaluationView", view.body)).toMatchObject({ ok: true });

    const list = await call("GET", "/evaluations", token);
    expect(list.body.evaluations[0]).toMatchObject({ id, status: "graded", feeLamports: 0, share: { kind: "none" } });
    expect(validateApiResponse("evaluationList", list.body)).toMatchObject({ ok: true });

    expect((await call("POST", `/evaluations/${id}/cancel`, token)).status).toBe(409);
  });

  it("a free evaluation whose every run failed to grade ends failed, not issued", async () => {
    const created = await call("POST", "/evaluations", dflToken(dfl), freeBody());
    const run = store.runs[0]!;
    // Every run ended without a grade (here: cancelled by the runner): no graded run → failed.
    Object.assign(run, { status: "cancelled", completedAt: new Date().toISOString() });
    const issuer = createEvaluationIssuer({ store, runs: new FakeRunsStore(), log: () => undefined });
    await issuer.processEvaluation(created.body.evaluationId);
    expect(store.evaluations[0]!.status).toBe("failed");
  });
});
