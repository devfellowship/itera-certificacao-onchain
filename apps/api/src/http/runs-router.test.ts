import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { decryptRunKey } from "../domain/run-key.js";
import { digestOf } from "../domain/digest.js";
import type { EvidenceManifest } from "../domain/grader.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { FakeRunsStore } from "../domain/runs-store.fake.js";
import type { ProofIssuer } from "../domain/runs-store.js";
import { issueSessionToken } from "./auth.js";
import { publicSuiteView, redactText } from "./runs-router.js";

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

const RUN_KEY_SECRET = "k".repeat(48);
const USER_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

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
  server = createApp(repo, { runs: { store, runKeySecret: RUN_KEY_SECRET, ...(withIssuer ? { proofIssuer: issuer } : {}) } }).listen(0);
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
    body: JSON.stringify({ agentId, benchmarkId: "webhook-ledger", benchmarkVersion: "1", modelApiKey: USER_KEY }),
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

  it("BYOK: stores the caller's model key sealed and never returns it", async () => {
    const res = await createRun();
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).not.toContain(USER_KEY);
    const { runId } = JSON.parse(text);
    const sealed = store.modelKeys.get(runId)!;
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(USER_KEY);
    expect(decryptRunKey(sealed, RUN_KEY_SECRET)).toBe(USER_KEY);
    const detail = await fetch(`${baseUrl}/runs/${runId}`, { headers: auth(OWNER) });
    expect(await detail.text()).not.toContain(sealed);

    const bad = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: auth(OWNER),
      body: JSON.stringify({ agentId, benchmarkId: "webhook-ledger", benchmarkVersion: "1", modelApiKey: "short" }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/modelApiKey/);
  });

  it("platform key: without modelApiKey the run is queued with no sealed key (ITERA pays the tokens)", async () => {
    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: auth(OWNER),
      body: JSON.stringify({ agentId, benchmarkId: "webhook-ledger", benchmarkVersion: "1" }),
    });
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    expect(store.modelKeys.has(runId)).toBe(false);
  });

  it("BYOK: 503 when the server has no ITERA_RUN_KEY_SECRET, but a platform run still works", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createApp(repo, { runs: { store } }).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await createRun()).status).toBe(503);
    const platform = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: auth(OWNER),
      body: JSON.stringify({ agentId, benchmarkId: "webhook-ledger", benchmarkVersion: "1" }),
    });
    expect(platform.status).toBe(202);
  });

  it("refuses an agent of another wallet, an unknown benchmark, and an agent without a version", async () => {
    expect((await createRun(OTHER)).status).toBe(403);
    const bad = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: auth(OWNER),
      body: JSON.stringify({ agentId, benchmarkId: "nope", benchmarkVersion: "1", modelApiKey: USER_KEY }),
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

describe("model cost", () => {
  it("GET /runs/:id shows modelCostUsd and tokens (null until measured)", async () => {
    const { runId } = await (await createRun()).json();
    let body = await (await fetch(`${baseUrl}/runs/${runId}`)).json();
    expect(body.modelCostUsd).toBeNull();
    expect(body.modelTokens).toBeNull();
    finish(runId);
    Object.assign(store.runs[0]!, { modelCostUsd: 0.0421, modelTokensIn: 380000, modelTokensOut: 9000 });
    body = await (await fetch(`${baseUrl}/runs/${runId}`)).json();
    expect(body.modelCostUsd).toBe(0.0421);
    expect(body.modelTokens).toEqual({ in: 380000, out: 9000 });
  });

  it("GET /models/:id/estimate: average of recorded runs of (task, model)", async () => {
    for (const cost of [0.04, 0.06]) {
      const { runId } = await (await createRun()).json();
      finish(runId);
      const run = store.runs.find((r) => r.id === runId)!;
      Object.assign(run, {
        evidenceManifest: { ...manifest, runner: { model: "qwen/qwen3-coder" } },
        modelCostUsd: cost,
        modelTokensIn: 100000,
        modelTokensOut: 5000,
      });
    }
    for (const path of ["qwen/qwen3-coder", "qwen%2Fqwen3-coder"]) {
      const res = await fetch(`${baseUrl}/models/${path}/estimate?task=webhook-ledger&version=1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        model: "qwen/qwen3-coder",
        estimatedCostUsd: 0.05,
        basis: "history",
        sampleSize: 2,
        tokens: { in: 100000, out: 5000 },
        runFeeUsd: 0.1,
      });
    }
  });

  it("GET /models/:id/estimate: list price × default token budget when there is no history", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const prices = vi.fn(async (id: string) => (id === "anthropic/claude-haiku-4.5" ? { prompt: 1e-6, completion: 5e-6 } : null));
    server = createApp(repo, { runs: { store, runKeySecret: RUN_KEY_SECRET, prices } }).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${baseUrl}/models/anthropic/claude-haiku-4.5/estimate?task=webhook-ledger&version=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ basis: "list_price", sampleSize: 0, pricePerMillionTokens: { prompt: 1, completion: 5 } });
    expect(body.estimatedCostUsd).toBeCloseTo(body.tokens.in * 1e-6 + body.tokens.out * 5e-6, 6);
    expect((await fetch(`${baseUrl}/models/nobody/none/estimate?task=webhook-ledger&version=1`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/models/anthropic/claude-haiku-4.5/estimate`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/models/bad%20id/estimate?task=t&version=1`)).status).toBe(400);
  });
});

describe("publicSuiteView", () => {
  it("keeps counts and case results but strips worker tmp paths from case files", () => {
    const view = publicSuiteView({
      total: 2,
      passed: 1,
      failed: 1,
      cases: [
        { name: "public checks a valid signed event settles once", file: "/tmp/itera-eval-uBITxJ/fixture/tests/public.test.ts", passed: true },
        { name: "other", file: "/tmp/itera-eval-x/elsewhere.ts", passed: false },
      ],
    } as never);
    expect(view).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      cases: [
        { name: "public checks a valid signed event settles once", file: "tests/public.test.ts", passed: true },
        { name: "other", file: "<tmp>", passed: false },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("/tmp/");
    expect(publicSuiteView({ total: 1, passed: 1, failed: 0 })).toEqual({ total: 1, passed: 1, failed: 0 });
  });
});
