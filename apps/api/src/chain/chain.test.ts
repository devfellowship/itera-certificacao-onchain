import { generateKeyPairSigner, getBase64EncodedWireTransaction, getBase64Encoder, getTransactionDecoder, signTransaction, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { Minter, RunResultData } from "./attestation.js";
import { IPFS_GATEWAY_URL } from "./config.js";
import { buildEvidenceDocument, redactText } from "./evidence.js";
import { manifestBytes, sha256Hex, type Pinner } from "./ipfs.js";
import { IPFS_NOT_CONFIGURED, issueProof, ProofPreconditionError } from "./issue-proof.js";
import { renderNftPng } from "./nft-image.js";
import { FakeProofStore, type ProofRun } from "./proof-store.js";
import { buildRunStartTx, RunStartError, verifyRunStartTx, type BuildRunStartTxInput } from "./run-start.js";

const BLOCKHASH = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" as const;
// Only getLatestBlockhash is called by buildRunStartTx.
const fakeRpc = {
  getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }) }),
} as never;

async function signAsUser(wireTxB64: string, user: KeyPairSigner): Promise<string> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireTxB64));
  const signed = await signTransaction([user.keyPair], tx as never);
  return getBase64EncodedWireTransaction(signed as never);
}

function input(runId: string, userWallet: string): BuildRunStartTxInput {
  return {
    runId,
    userWallet,
    agentRepo: "acme/agent",
    agentCommit: "0123456789abcdef0123456789abcdef01234567",
    modelId: "anthropic/claude-sonnet-4.5",
    evaluatorCommit: "fedcba9876543210fedcba9876543210fedcba98",
    fixtureHash: "a".repeat(64),
    scenarioId: "webhook-ledger",
  };
}

describe("run-start memo", () => {
  it("accepts the tx it built once the owner signs it", async () => {
    const hot = await generateKeyPairSigner();
    const user = await generateKeyPairSigner();
    const built = await buildRunStartTx(input("run-1", user.address), { rpc: fakeRpc, hotSigner: hot });
    expect(built.memo.startsWith("itera-run:v1:")).toBe(true);
    expect(JSON.parse(built.memo.slice("itera-run:v1:".length)).run_id).toBe("run-1");

    const signed = await signAsUser(built.wireTransactionBase64, user);
    const verified = await verifyRunStartTx(signed, "run-1", hot.address, { ownerWallet: user.address });
    expect(verified.userWallet).toBe(user.address);
    expect(verified.payload.scenario_id).toBe("webhook-ledger");
  });

  it("refuses an unsigned tx, a tx for another run, and a tx for another wallet", async () => {
    const hot = await generateKeyPairSigner();
    const user = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const built = await buildRunStartTx(input("run-1", user.address), { rpc: fakeRpc, hotSigner: hot });

    await expect(verifyRunStartTx(built.wireTransactionBase64, "run-1", hot.address)).rejects.toMatchObject({ code: "invalid_tx" });
    const signed = await signAsUser(built.wireTransactionBase64, user);
    await expect(verifyRunStartTx(signed, "run-2", hot.address)).rejects.toMatchObject({ code: "wrong_run" });
    await expect(verifyRunStartTx(signed, "run-1", hot.address, { ownerWallet: other.address })).rejects.toMatchObject({
      code: "wrong_wallet",
    });
  });

  it("refuses a tx that the TestMyAgent hot signer did not build", async () => {
    const hot = await generateKeyPairSigner();
    const impostor = await generateKeyPairSigner();
    const user = await generateKeyPairSigner();
    // Same shape, but paid and signed by another key: the relay must not forward it.
    const forged = await buildRunStartTx(input("run-1", user.address), { rpc: fakeRpc, hotSigner: impostor });
    const signed = await signAsUser(forged.wireTransactionBase64, user);
    await expect(verifyRunStartTx(signed, "run-1", hot.address)).rejects.toBeInstanceOf(RunStartError);
    await expect(verifyRunStartTx("not base64 at all", "run-1", hot.address)).rejects.toMatchObject({ code: "invalid_tx" });
  });

  it("refuses bad input", async () => {
    const hot = await generateKeyPairSigner();
    await expect(buildRunStartTx(input("run-1", "not-a-wallet"), { rpc: fakeRpc, hotSigner: hot })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

const manifest = {
  schema_version: "1",
  evaluator_version: "0.1.0",
  scenario_id: "webhook-ledger",
  generated_at: "2026-10-12T00:00:00.000Z",
  fixture_hash: "f".repeat(64),
  patch_hash: "p".repeat(64),
  patch_scope: { changed_files: ["src/ledger.ts"], allowed: true, violations: [] },
  tests: {
    public_baseline: { total: 2, passed: 1, failed: 1, cases: [{ name: "pub a", file: "/tmp/itera-x/tests/public.test.ts", passed: true }] },
    public_after_patch: { total: 2, passed: 2, failed: 0, cases: [] },
    hidden: { total: 3, passed: 3, failed: 0, cases: [{ name: "SECRET hidden case", file: "hidden.test.ts", passed: true }] },
  },
  score: { public_behavior: 30, hidden_behavior: 40, regression: 10, patch_integrity_and_scope: 10, reproducible_evidence: 5, total: 95 },
  errors: ["failed at /tmp/itera-api-grade-abc/patch.diff"],
};

function run(overrides: Partial<ProofRun> = {}): ProofRun {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    ownerWallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    runStartSig: "5sig",
    status: "pass",
    evidenceManifest: manifest,
    scoreTotal: 95,
    benchmarkId: "webhook-ledger",
    benchmarkVersion: "1",
    agentId: "agent-1",
    agentName: "acme agent",
    agentRepo: "acme/agent",
    agentCommit: "0123456789abcdef0123456789abcdef01234567",
    modelId: "anthropic/claude-sonnet-4.5",
    ...overrides,
  };
}

class FakePinner implements Pinner {
  pinned: Uint8Array[] = [];
  async pin(bytes: Uint8Array) {
    this.pinned.push(bytes);
    return { cid: `bafy${this.pinned.length}` };
  }
}

class FakeMinter implements Minter {
  calls: Array<{ recipient: string; data: RunResultData; nonceSeed?: string }> = [];
  async addressesFor() {
    return { attestationAddress: "Attest1111", nftMint: "Mint1111" };
  }
  async mint(input: { recipient: string; data: RunResultData; nonceSeed?: string }) {
    this.calls.push(input);
    return { attestationAddress: "Attest1111", nftMint: "Mint1111", txSig: "MintTx1", alreadyExisted: false };
  }
}

describe("issueProof", () => {
  it("v1 single run: nonce seed = run_start_sig; v2 evaluation run: `${sig}:${slot run id}` and the evidence names the evaluation", async () => {
    const pinner = new FakePinner();
    const minter = new FakeMinter();
    await issueProof(run(), { store: new FakeProofStore(), pinner, minter });
    expect(minter.calls[0]!.nonceSeed).toBe("5sig");
    const slot = "22222222-2222-4222-8222-222222222222";
    await issueProof(run({ runId: "33333333-3333-4333-8333-333333333333", evaluationId: "e1", slotRunId: slot }), { store: new FakeProofStore(), pinner, minter });
    expect(minter.calls[1]!.nonceSeed).toBe(`5sig:${slot}`);
    const evidence = JSON.parse(new TextDecoder().decode(pinner.pinned[1]));
    expect(evidence.run).toMatchObject({ evaluation_id: "e1", slot_run_id: slot });
    expect(JSON.parse(new TextDecoder().decode(pinner.pinned[0])).run.evaluation_id).toBeUndefined();
  });

  it("records failed 'ipfs not configured' without a pinner — and never invents a CID", async () => {
    const store = new FakeProofStore();
    const minter = new FakeMinter();
    const proof = await issueProof(run(), { store, pinner: null, minter });
    expect(proof.status).toBe("failed");
    expect(proof.error).toBe(IPFS_NOT_CONFIGURED);
    expect(proof.evidenceCid).toBeNull();
    expect(proof.nftMint).toBeNull();
    expect(minter.calls).toHaveLength(0);
  });

  it("pins the redacted evidence, mints to the owner, and is idempotent", async () => {
    const store = new FakeProofStore();
    const pinner = new FakePinner();
    const minter = new FakeMinter();
    const first = await issueProof(run(), { store, pinner, minter });
    expect(first).toMatchObject({ status: "confirmed", evidenceCid: "bafy1", nftMint: "Mint1111", txSig: "MintTx1" });
    expect(first.manifestSha256).toBe(sha256Hex(pinner.pinned[0]));

    const pinnedText = new TextDecoder().decode(pinner.pinned[0]);
    expect(pinnedText).not.toContain("SECRET hidden case");
    expect(pinnedText).not.toContain("/tmp/");
    expect(JSON.parse(pinnedText).run.run_start_sig).toBe("5sig");
    expect(minter.calls[0]).toMatchObject({
      recipient: run().ownerWallet,
      data: { evidence_cid: "bafy1", scenario_id: "webhook-ledger", score_total: 95, run_start_sig: "5sig", manifest_sha256: first.manifestSha256 },
    });

    const second = await issueProof(run(), { store, pinner, minter });
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(pinner.pinned).toHaveLength(1);
    expect(minter.calls).toHaveLength(1);
  });

  it("retries a failed proof once IPFS is configured, with the same hash", async () => {
    const store = new FakeProofStore();
    const failed = await issueProof(run(), { store, pinner: null, minter: new FakeMinter() });
    const ok = await issueProof(run(), { store, pinner: new FakePinner(), minter: new FakeMinter() });
    expect(ok.status).toBe("confirmed");
    expect(ok.manifestSha256).toBe(failed.manifestSha256);
  });

  it("records a mint failure as failed with the deterministic addresses", async () => {
    const store = new FakeProofStore();
    const minter = new FakeMinter();
    minter.mint = async () => {
      throw new Error("devnet down");
    };
    const proof = await issueProof(run(), { store, pinner: new FakePinner(), minter });
    expect(proof).toMatchObject({ status: "failed", nftMint: "Mint1111", evidenceCid: "bafy1" });
    expect(proof.error).toContain("devnet down");
  });

  it("refuses runs that cannot carry a proof", async () => {
    const deps = { store: new FakeProofStore(), pinner: new FakePinner(), minter: new FakeMinter() };
    await expect(issueProof(run({ status: "infra_error" }), deps)).rejects.toBeInstanceOf(ProofPreconditionError);
    await expect(issueProof(run({ runStartSig: null }), deps)).rejects.toBeInstanceOf(ProofPreconditionError);
    await expect(issueProof(run({ ownerWallet: null }), deps)).rejects.toBeInstanceOf(ProofPreconditionError);
  });
});

describe("evidence + image", () => {
  it("serializes deterministically", () => {
    expect(sha256Hex(manifestBytes(buildEvidenceDocument(run())))).toBe(sha256Hex(manifestBytes(buildEvidenceDocument(run()))));
    expect(redactText("see /tmp/abc/def.ts here")).toBe("see <tmp> here");
    expect(IPFS_GATEWAY_URL).toContain("/ipfs");
  });

  it("renders a PNG", () => {
    const png = renderNftPng({ scoreTotal: 100, benchmark: "webhook-ledger", agent: "acme/<agent>", model: "m", proofHash: "ab".repeat(32) });
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.length).toBeGreaterThan(5_000);
  });
});
