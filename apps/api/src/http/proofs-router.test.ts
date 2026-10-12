import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeProofStore, type ProofRun } from "../chain/proof-store.js";
import { RunStartError } from "../chain/run-start.js";
import { issueSessionToken } from "./auth.js";
import { createProofsRouter } from "./proofs-router.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const manifest = {
  scenario_id: "webhook-ledger",
  patch_scope: { changed_files: ["src/ledger.ts"], allowed: true, violations: [] },
  tests: {
    public_baseline: { total: 4, passed: 1, failed: 3, cases: [] },
    public_after_patch: { total: 4, passed: 4, failed: 0, cases: [] },
    hidden: { total: 6, passed: 5, failed: 1, cases: [{ name: "SECRET", file: "h.ts", passed: true }] },
  },
  score: { public_behavior: 30, hidden_behavior: 35, regression: 10, patch_integrity_and_scope: 10, reproducible_evidence: 5, total: 90 },
  errors: [],
};

function run(over: Partial<ProofRun> = {}): ProofRun {
  return {
    runId: RUN_ID,
    ownerWallet: OWNER,
    runStartSig: null,
    status: "pass",
    evidenceManifest: manifest,
    scoreTotal: 90,
    benchmarkId: "webhook-ledger",
    benchmarkVersion: "1",
    agentId: "agent-a",
    agentName: "acme/agent-a",
    agentRepo: "acme/agent-a",
    agentCommit: "c0ffee",
    modelId: "m1",
    ...over,
  };
}

let server: Server;
let base: string;
let store: FakeProofStore;
const relay = vi.fn();

beforeEach(async () => {
  relay.mockReset();
  store = new FakeProofStore();
  const app = express();
  app.use(express.json());
  app.use(createProofsRouter({ store, submitRunStart: relay }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

const auth = (wallet: string) => ({ Authorization: `Bearer ${issueSessionToken(wallet).token}`, "Content-Type": "application/json" });

describe("POST /runs/:id/start-signature", () => {
  it("needs a session, the owner, and a tx", async () => {
    store.runs.set(RUN_ID, run());
    expect((await fetch(`${base}/runs/${RUN_ID}/start-signature`, { method: "POST" })).status).toBe(401);
    const other = await fetch(`${base}/runs/${RUN_ID}/start-signature`, { method: "POST", headers: auth(OTHER), body: "{}" });
    expect(other.status).toBe(403);
    const empty = await fetch(`${base}/runs/${RUN_ID}/start-signature`, { method: "POST", headers: auth(OWNER), body: "{}" });
    expect(empty.status).toBe(400);
    expect(relay).not.toHaveBeenCalled();
  });

  it("relays with the owner wallet and stores the signature", async () => {
    store.runs.set(RUN_ID, run());
    relay.mockResolvedValue({ signature: "SIG1" });
    const res = await fetch(`${base}/runs/${RUN_ID}/start-signature`, {
      method: "POST",
      headers: auth(OWNER),
      body: JSON.stringify({ wireTransactionBase64: "AAAA" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runStartSig: string }).runStartSig).toBe("SIG1");
    expect(relay).toHaveBeenCalledWith("AAAA", RUN_ID, { ownerWallet: OWNER });
    expect(store.runs.get(RUN_ID)?.runStartSig).toBe("SIG1");
  });

  it("maps a refused tx to 400", async () => {
    store.runs.set(RUN_ID, run());
    relay.mockRejectedValue(new RunStartError("memo is for run x", "wrong_run"));
    const res = await fetch(`${base}/runs/${RUN_ID}/start-signature`, {
      method: "POST",
      headers: auth(OWNER),
      body: JSON.stringify({ wireTransactionBase64: "AAAA" }),
    });
    expect(res.status).toBe(400);
    expect(store.runs.get(RUN_ID)?.runStartSig).toBeNull();
  });
});

describe("GET /proofs/:hash", () => {
  it("returns the landing-page view without hidden test names", async () => {
    store.runs.set(RUN_ID, run({ runStartSig: "SIG1" }));
    await store.upsertProof({
      runId: RUN_ID,
      ownerWallet: OWNER,
      manifestSha256: HASH_A,
      evidenceCid: "bafy1",
      attestationAddress: "Att1",
      nftMint: "Mint1",
      txSig: "Tx1",
      status: "confirmed",
      error: null,
    });
    const res = await fetch(`${base}/proofs/${HASH_A}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      proofHash: HASH_A,
      status: "confirmed",
      ownerWallet: OWNER,
      agent: { repo: "acme/agent-a", model: "m1", commit: "c0ffee" },
      score: { total: 90, parts: { hidden_behavior: 35 } },
      tests: { hidden: { total: 6, passed: 5, failed: 1 } },
      nftMint: "Mint1",
      evidenceCid: "bafy1",
      verify: { nftMint: "Mint1" },
    });
    expect(body.explorer.nft).toContain("Mint1");
    expect(body.explorer.runStart).toContain("SIG1");
    expect(body.nftImageUrl).toMatch(/\/nft\/Mint1\.png$/);
  });

  it("answers 404 for an unknown or malformed hash", async () => {
    expect((await fetch(`${base}/proofs/${HASH_B}`)).status).toBe(404);
    expect((await fetch(`${base}/proofs/nope`)).status).toBe(404);
  });
});

describe("GET /leaderboard", () => {
  it("lists the best confirmed proof per agent, highest first", async () => {
    const add = async (runId: string, agentId: string, score: number, hash: string, status: "confirmed" | "failed") => {
      store.runs.set(runId, run({ runId, agentId, agentRepo: `acme/${agentId}`, scoreTotal: score }));
      await store.upsertProof({ runId, ownerWallet: OWNER, manifestSha256: hash, evidenceCid: "c", attestationAddress: "a", nftMint: `M-${runId}`, txSig: "t", status, error: null });
    };
    await add("r1", "agent-a", 70, HASH_A, "confirmed");
    await add("r2", "agent-a", 95, HASH_B, "confirmed");
    await add("r3", "agent-b", 80, HASH_C, "confirmed");
    await add("r4", "agent-c", 99, "d".repeat(64), "failed");

    expect((await fetch(`${base}/leaderboard`)).status).toBe(400);
    const res = await fetch(`${base}/leaderboard?benchmark=webhook-ledger`);
    const body = (await res.json()) as { entries: Array<{ rank: number; agentId: string; scoreTotal: number; proofHash: string; proofUrl: string }> };
    expect(body.entries.map((e) => [e.rank, e.agentId, e.scoreTotal])).toEqual([
      [1, "agent-a", 95],
      [2, "agent-b", 80],
    ]);
    expect(body.entries[0].proofUrl).toMatch(new RegExp(`/proof/${HASH_B}$`));
    const other = (await (await fetch(`${base}/leaderboard?benchmark=other`)).json()) as { entries: unknown[] };
    expect(other.entries).toEqual([]);
  });
});
