import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { digestOf } from "../domain/digest.js";
import type { EvidenceManifest } from "../domain/grader.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { FakeRunsStore } from "../domain/runs-store.fake.js";
import type { ProofIssuer } from "../domain/runs-store.js";
import { issueSessionToken } from "./auth.js";
import { redactText } from "./runs-router.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const manifest: EvidenceManifest = {
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
    hidden: { total: 6, passed: 5, failed: 1 },
  },
  score: { public_behavior: 30, hidden_behavior: 25, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5, total: 85 },
  errors: ["hidden/idempotency.test.ts failed at /tmp/itera-run-abc/fixture/src/ledger.ts:12"],
};

let server: Server;
let baseUrl: string;
let repo: FakeRepository;
let store: FakeRunsStore;
let issuer: ProofIssuer & { issueProof: ReturnType<typeof vi.fn> };
let agentId: string;

function auth(wallet: string) {
  return { Authorization: `Bearer ${issueSessionToken(wallet).token}`, "Content-Type": "application/json" };
}

async function start(withIssuer = true) {
  server = createApp(repo, { runs: { store, ...(withIssuer ? { proofIssuer: issuer } : {}) } }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  repo = new FakeRepository();
  store = new FakeRunsStore();
  agentId = randomUUID();
  store.agents.push({ id: agentId, ownerWallet: OWNER, repoFullName: "acme/agent", agentPath: ".", model: "m" });
  store.versions.push({ id: randomUUID(), agentId, commitSha: "abc123", createdAt: 1 });
  issuer = {
    issueProof: vi.fn().mockImplementation(async (input) => ({ proofHash: input.manifestSha256, status: "pending" })),
  };
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function createRun(wallet = OWNER) {
  return fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: auth(wallet),
    body: JSON.stringify({ agentId, benchmarkId: "webhook-ledger", benchmarkVersion: "1" }),
  });
}

function finish(runId: string) {
  const run = store.runs.find((r) => r.id === runId)!;
  run.status = "pass";
  run.phase = "done";
  run.evidenceManifest = manifest;
  run.scoreTotal = 85;
  run.completedAt = new Date().toISOString();
  store.patches.set(runId, "diff --git a/src/ledger.ts b/src/ledger.ts\n");
  store.actions.set(runId, 7);
}

describe("POST /runs", () => {
  it("requires a session", async () => {
    const res = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("queues a run owned by the wallet (202)", async () => {
    const res = await createRun();
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("queued");
    expect(body.runStartMemo).toBeNull();
    expect(store.runs[0]).toMatchObject({ id: body.runId, ownerWallet: OWNER, status: "queued", agentVersionId: store.versions[0]!.id });
  });

  it("refuses an agent of another wallet, an unknown benchmark, and an agent without a version", async () => {
    expect((await createRun(OTHER)).status).toBe(403);
    const bad = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: auth(OWNER),
      body: JSON.stringify({ agentId, benchmarkId: "nope", benchmarkVersion: "1" }),
    });
    expect(bad.status).toBe(404);
    store.versions = [];
    expect((await createRun()).status).toBe(409);
  });

  it("enforces 5 runs per wallet per day", async () => {
    for (let i = 0; i < 5; i++) expect((await createRun()).status).toBe(202);
    expect((await createRun()).status).toBe(429);
  });

  it("answers 503 (not 500) when the 0001 migration is not applied, and legacy routes still work", async () => {
    store.schemaReady = false;
    const res = await createRun();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/0001_runs_async/);
    const legacy = await fetch(`${baseUrl}/task-packs`);
    expect(legacy.status).toBe(200);
  });
});

describe("GET /runs", () => {
  it("lists only the caller's runs with ?mine=1", async () => {
    await createRun();
    const other = randomUUID();
    store.agents.push({ id: other, ownerWallet: OTHER, repoFullName: null, agentPath: ".", model: null });
    store.versions.push({ id: randomUUID(), agentId: other, commitSha: "def", createdAt: 2 });
    await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: auth(OTHER),
      body: JSON.stringify({ agentId: other, benchmarkId: "webhook-ledger", benchmarkVersion: "1" }),
    });
    const res = await fetch(`${baseUrl}/runs?mine=1`, { headers: auth(OWNER) });
    const body = await res.json();
    expect(body.runs).toHaveLength(1);
    expect((await fetch(`${baseUrl}/runs`, { headers: auth(OWNER) })).status).toBe(400);
  });

  it("GET /runs/:id is public and redacted", async () => {
    const { runId } = await (await createRun()).json();
    finish(runId);
    const res = await fetch(`${baseUrl}/runs/${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      runId,
      status: "pass",
      phase: "done",
      scoreTotal: 85,
      tests: { public: { total: 4, passed: 4 }, hidden: { total: 6, passed: 5, failed: 1 } },
      patchScope: { changedFiles: ["src/ledger.ts"], allowed: true },
      actionsCount: 7,
      proof: null,
    });
    expect(body.score.parts).toEqual({ public_behavior: 30, hidden_behavior: 25, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 });
    const text = JSON.stringify(body);
    expect(text).not.toContain("/tmp/");
    expect(text).not.toContain("idempotency.test");
    expect((await fetch(`${baseUrl}/runs/${randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/runs/not-a-uuid`)).status).toBe(404);
  });
});

describe("POST /runs/:id/publish", () => {
  it("is owner-only, needs a finished run, derives criteria on the server, and is idempotent", async () => {
    const { runId } = await (await createRun()).json();
    const url = `${baseUrl}/runs/${runId}/publish`;
    expect((await fetch(url, { method: "POST", headers: auth(OWNER) })).status).toBe(409);
    finish(runId);
    expect((await fetch(url, { method: "POST", headers: auth(OTHER) })).status).toBe(403);

    const res = await fetch(url, {
      method: "POST",
      headers: auth(OWNER),
      body: JSON.stringify({ criteriaResults: [{ requirement: "forged", result: "pass" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ proofHash: digestOf(manifest), status: "pending" });
    const input = issuer.issueProof.mock.calls[0]![0];
    expect(input.criteria.map((c: { requirement: string }) => c.requirement)).not.toContain("forged");
    expect(input.criteria).toContainEqual({ requirement: "Hidden tests pass after the patch", result: "5/6" });
    expect(input.agentVersion.commitSha).toBe("abc123");

    store.proofs.set(runId, {
      runId,
      status: "confirmed",
      manifestSha256: digestOf(manifest),
      nftMint: "mint",
      txSig: "sig",
      evidenceCid: null,
      attestationAddress: null,
      error: null,
    });
    const again = await fetch(url, { method: "POST", headers: auth(OWNER) });
    expect(await again.json()).toEqual({ proofHash: digestOf(manifest), status: "confirmed" });
    expect(issuer.issueProof).toHaveBeenCalledTimes(1);

    const view = await (await fetch(`${baseUrl}/runs/${runId}`)).json();
    expect(view.proof).toMatchObject({ status: "confirmed", nftMint: "mint", txSig: "sig", proofHash: digestOf(manifest) });
  });

  it("answers 503 while no proof issuer is wired", async () => {
    server.close();
    await start(false);
    const { runId } = await (await createRun()).json();
    finish(runId);
    const res = await fetch(`${baseUrl}/runs/${runId}/publish`, { method: "POST", headers: auth(OWNER) });
    expect(res.status).toBe(503);
  });
});

describe("redactText", () => {
  it("removes tmp paths and hidden test names", () => {
    expect(redactText("boom at /tmp/x/y.ts:3 in hidden/a.test.ts")).toBe("boom at <tmp>:3 in <hidden-test>");
  });
});
