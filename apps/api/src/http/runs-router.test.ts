import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { decryptRunKey } from "../domain/run-key.js";
import { digestOf } from "../domain/digest.js";
import type { EvidenceManifest } from "../domain/evidence-manifest.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { FakeRunsStore } from "../domain/runs-store.fake.js";
import type { ProofIssuer } from "../domain/runs-store.js";
import { issueSessionToken } from "./auth.js";
import { validateApiResponse } from "@itera/contracts";
import type { RunOrigin, RunOriginLookup } from "../self-declared/run-guard.js";
import { LEGACY_RUNS_GONE_FOR_DFL, publicSuiteView, redactText } from "./runs-router.js";
import { createHash } from "node:crypto";

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

class FakeLookup implements RunOriginLookup {
  runs = new Map<string, RunOrigin>();
  async originOf(id: string) {
    return this.runs.get(id) ?? null;
  }
}

let server: Server;
let baseUrl: string;
let repo: FakeRepository;
let store: FakeRunsStore;
let lookup: FakeLookup;
let issuer: ProofIssuer & { issueProof: ReturnType<typeof vi.fn> };
let agentId: string;

function auth(wallet: string) {
  return { Authorization: `Bearer ${issueSessionToken(wallet).token}`, "Content-Type": "application/json" };
}

async function start(withIssuer = true) {
  server = createApp(repo, { runs: { store, runKeySecret: RUN_KEY_SECRET, ...(withIssuer ? { proofIssuer: issuer } : {}) }, runOrigins: lookup }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  repo = new FakeRepository();
  store = new FakeRunsStore();
  lookup = new FakeLookup();
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

  it("T6: refuses a dfl principal with 410 and writes no runs row, with or without a model key", async () => {
    // The agent belongs to the dfl principal, so only the principal kind decides the refusal.
    const dflId = `dfl:${randomUUID()}`;
    store.agents[0]!.ownerWallet = dflId;
    const dflAuth = { Authorization: `Bearer ${issueSessionToken(dflId, Date.now(), "dfl").token}`, "Content-Type": "application/json" };
    for (const extra of [{}, { modelApiKey: USER_KEY }]) {
      const res = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: dflAuth,
        body: JSON.stringify({ agentId, benchmarkId: "webhook-ledger", benchmarkVersion: "1", ...extra }),
      });
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body).toEqual(LEGACY_RUNS_GONE_FOR_DFL);
      // L15a: the pointer goes to the local runner, never to the hosted start routes.
      expect(JSON.stringify(body)).not.toContain("POST /evaluations");
      expect(body.replacement.selfDeclared).toBe("POST /self-declared-results");
      expect(body.replacement.localRunner.steps).toHaveLength(3);
    }
    // An empty or invalid body gets the same 410: the refusal comes before validation.
    const empty = await fetch(`${baseUrl}/runs`, { method: "POST", headers: dflAuth, body: "{}" });
    expect(empty.status).toBe(410);
    expect(store.runs).toHaveLength(0);
    expect(store.modelKeys.size).toBe(0);
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

  it("GET /runs/:id keeps stored artifacts owner-only while the public summary stays redacted", async () => {
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
      patchScope: { changedFiles: [], allowed: true },
      actionsCount: 7,
      proof: null,
    });
    expect(body.score.parts).toEqual({ public_behavior: 30, hidden_behavior: 25, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 });
    const text = JSON.stringify(body);
    expect(text).not.toContain("/tmp/");
    expect(text).not.toContain("idempotency.test");
    expect(body.patch).toBeNull();
    expect(body.evidence).toBeNull();
    expect(body.errors).toEqual([]);

    const other = await (await fetch(`${baseUrl}/runs/${runId}`, { headers: auth(OTHER) })).json();
    expect(other.patch).toBeNull();
    expect(other.patchScope.changedFiles).toEqual([]);
    expect(other.evidence).toBeNull();

    const owner = await (await fetch(`${baseUrl}/runs/${runId}`, { headers: auth(OWNER) })).json();
    expect(owner.patch).toContain("diff --git");
    expect(owner.patchScope.changedFiles).toEqual(["src/ledger.ts"]);
    expect(owner.errors).toHaveLength(1);
    // U22: the response matches packages/contracts/schemas/api/run-detail.schema.json (Ajv), and
    // the operational state is kept apart from the verdict.
    expect(validateApiResponse("runDetail", body)).toEqual({ ok: true, value: body });
    expect(body.result).toEqual({ state: "completed", verdict: "pass", scored: true });
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

describe("run result vocabulary (U22)", () => {
  it("an infra_error run is inconclusive and UNSCORED; a queued run has no verdict; both match the schema", async () => {
    const { runId } = await (await createRun()).json();
    let body = await (await fetch(`${baseUrl}/runs/${runId}`)).json();
    expect(body.result).toEqual({ state: "queued", verdict: null, scored: false });
    expect(validateApiResponse("runDetail", body).ok).toBe(true);
    finish(runId);
    store.runs.find((r) => r.id === runId)!.status = "infra_error";
    body = await (await fetch(`${baseUrl}/runs/${runId}`)).json();
    expect(body.result).toEqual({ state: "infra_error", verdict: "inconclusive", scored: false });
    expect(validateApiResponse("runDetail", body).ok).toBe(true);
  });

  it("the schema refuses a response that leaks a worker path", () => {
    const leaked = {
      runId: "r", status: "pass", phase: "done", scoreTotal: 1, benchmark: { id: "b" }, createdAt: null, ownerWallet: null,
      score: { parts: null }, patchScope: null, proof: null, result: { state: "completed", verdict: "pass", scored: true },
      tests: { public: { total: 1, passed: 1, failed: 0, cases: [{ name: "t", file: "/tmp/itera-eval-x/workspace/tests/a.test.ts", passed: true }] }, publicBaseline: { total: 1, passed: 1, failed: 0 }, hidden: { total: 1, passed: 1, failed: 0 } },
      errors: ["failed at /tmp/itera-run-abc/fixture/src/x.ts:1"],
    };
    const r = validateApiResponse("runDetail", leaked);
    expect(r.ok).toBe(false);
  });
});

describe("GET /runs/:id/actions (screen 04 event log)", () => {
  const row = (seq: number, target: string | null, over: Record<string, unknown> = {}) => ({
    seq,
    tool: "bash",
    target,
    ok: true,
    occurredAt: new Date(Date.UTC(2026, 9, 12, 12, 0, seq)).toISOString(),
    ...over,
  });

  it("is a public read, 404 for an unknown or unowned run, 400 for a bad cursor", async () => {
    expect((await fetch(`${baseUrl}/runs/not-a-uuid/actions`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/runs/${randomUUID()}/actions`)).status).toBe(404);
    const { runId } = await (await createRun()).json();
    expect((await fetch(`${baseUrl}/runs/${runId}/actions?after_seq=-1`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/runs/${runId}/actions?after_seq=abc`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/runs/${runId}/actions?limit=201`)).status).toBe(400);
    // No session header: the read is public.
    const res = await fetch(`${baseUrl}/runs/${runId}/actions`);
    expect(res.status).toBe(200);
    // run_actions rows do not exist yet for a queued run: an empty page that matches the schema.
    const body = await res.json();
    expect(body).toEqual({ runId, afterSeq: 0, actions: [], hasMore: false, nextAfterSeq: 0 });
    expect(validateApiResponse("runActions", body).ok).toBe(true);
  });

  it("pages by after_seq, 200 rows at most, and the page matches the schema", async () => {
    const { runId } = await (await createRun()).json();
    store.actionRows.set(runId, Array.from({ length: 450 }, (_, i) => row(i + 1, `src/file-${i + 1}.ts`)));
    const first = await (await fetch(`${baseUrl}/runs/${runId}/actions`)).json();
    expect(first.actions).toHaveLength(200);
    expect(first.actions[0].seq).toBe(1);
    expect(first).toMatchObject({ hasMore: true, nextAfterSeq: 200, afterSeq: 0 });
    const second = await (await fetch(`${baseUrl}/runs/${runId}/actions?after_seq=${first.nextAfterSeq}`)).json();
    expect(second.actions[0].seq).toBe(201);
    expect(second).toMatchObject({ hasMore: true, nextAfterSeq: 400 });
    const last = await (await fetch(`${baseUrl}/runs/${runId}/actions?after_seq=400`)).json();
    expect(last.actions).toHaveLength(50);
    expect(last).toMatchObject({ hasMore: false, nextAfterSeq: 450 });
    // Nothing new: the cursor stays where it was.
    const none = await (await fetch(`${baseUrl}/runs/${runId}/actions?after_seq=450`)).json();
    expect(none).toMatchObject({ actions: [], hasMore: false, nextAfterSeq: 450 });
    for (const page of [first, second, last, none]) expect(validateApiResponse("runActions", page)).toMatchObject({ ok: true });
    // The count in GET /runs/:id and the rows agree.
    finish(runId);
    store.actions.delete(runId);
    expect((await (await fetch(`${baseUrl}/runs/${runId}`)).json()).actionsCount).toBe(450);
  });

  it("sanitizes target: no absolute path, no secret, no URL query; the schema refuses a leak", async () => {
    const { runId } = await (await createRun()).json();
    const leaks = [
      "cat /workspace/src/ledger.ts",
      "cat /etc/passwd",
      "ls /home/runner/work/app && cd ~/secrets",
      "curl -H 'Authorization: Bearer sk-or-v1-abcdef0123456789abcdef0123456789' https://api.example.com/v1/x?api_key=abc123&u=1",
      "curl https://user:hunter2@example.com/repo.git",
      "OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef node run.js",
      "git push https://x-access-token:ghp_0123456789abcdefghijklmnopqrstuv@github.com/a/b.git",
      "echo " + "A1".repeat(40),
      "npm test -- --token abcdef123456 --reporter=json",
      `grep -rn "secret" ${"x".repeat(900)}`,
      "cat tests/hidden/ledger.hidden.test.ts",
    ];
    store.actionRows.set(runId, leaks.map((t, i) => row(i + 1, t)).concat([row(99, "src/ledger.ts"), row(100, null, { ok: null, tool: "web fetch!" })]));
    const body = await (await fetch(`${baseUrl}/runs/${runId}/actions`)).json();
    const all = JSON.stringify(body);
    for (const bad of ["/workspace", "/etc/passwd", "/home/runner", "hunter2", "sk-or-v1", "ghp_0123", "api_key=abc123", "abcdef123456", "ledger.hidden", "~/secrets", "A1A1A1A1"]) {
      expect(all).not.toContain(bad);
    }
    const byTarget = new Map<number, string | null>(body.actions.map((a: { seq: number; target: string | null }) => [a.seq, a.target]));
    expect(byTarget.get(1)).toBe("cat <path>");
    expect(byTarget.get(4)).toContain("Authorization: <redacted>");
    expect(byTarget.get(4)).toContain("https://api.example.com/v1/x");
    expect(byTarget.get(5)).toBe("curl https://example.com/repo.git");
    expect(byTarget.get(6)).toBe("OPENROUTER_API_KEY=<redacted> node run.js");
    expect(byTarget.get(10)!.length).toBeLessThanOrEqual(200);
    expect(byTarget.get(99)).toBe("src/ledger.ts");
    expect(byTarget.get(100)).toBeNull();
    expect(body.actions.find((a: { seq: number }) => a.seq === 100)).toMatchObject({ tool: "webfetch", ok: null });
    expect(validateApiResponse("runActions", body)).toMatchObject({ ok: true });
  });

  it("the schema itself refuses an unsanitized row", () => {
    const page = (target: string) => ({ runId: "r", afterSeq: 0, hasMore: false, nextAfterSeq: 1, actions: [{ seq: 1, tool: "bash", target, ok: true, occurredAt: "2026-10-12T12:00:00.000Z" }] });
    expect(validateApiResponse("runActions", page("cat src/a.ts")).ok).toBe(true);
    for (const bad of ["cat /workspace/src/a.ts", "ls ~/x/y", "curl -H 'Authorization: Bearer abcdef123456'", "export K=sk-or-v1-abcdef0123456789abcd", "x".repeat(201), "two\nlines"]) {
      expect(validateApiResponse("runActions", page(bad)).ok).toBe(false);
    }
  });
});

describe("GET /runs/:id/artifacts and /artifacts/file (L17a, owner only)", () => {
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const PATCH = "diff --git a/src/ledger.ts b/src/ledger.ts\n";
  const RESULT = '{"format":"tma-run-result/1","status":"pass"}\n';
  const HTML = "<!doctype html><h1>report</h1>\n";
  const LIMITS = { maxFileBytes: 524288, maxRunBytes: 2097152, maxCount: 25 };

  async function finishedRun() {
    const { runId } = await (await createRun()).json();
    finish(runId);
    store.addArtifact(runId, "files/out/chart.png", PNG);
    store.addArtifact(runId, "result.json", RESULT);
    store.addArtifact(runId, "agent/trace.jsonl", '{"type":"step"}\n');
    store.addArtifact(runId, "files/out/report.html", HTML);
    // rows that the list must leave out: a path outside the rules, and a not-allowlisted extension
    store.addObservation(runId, "artifact:../escape.json", "{}", sha("{}"));
    store.addObservation(runId, "artifact:files/run.sh", "echo", sha("echo"));
    return runId as string;
  }
  const list = (runId: string, headers: Record<string, string> = auth(OWNER)) => fetch(`${baseUrl}/runs/${runId}/artifacts`, { headers });
  const file = (runId: string, path: string | null, headers: Record<string, string> = auth(OWNER)) =>
    fetch(`${baseUrl}/runs/${runId}/artifacts/file${path === null ? "" : `?path=${encodeURIComponent(path)}`}`, { headers });

  it("401 without a session; 404 for not a uuid, unknown, legacy (no owner) and another wallet — on both routes", async () => {
    const runId = await finishedRun();
    const legacy = randomUUID();
    store.runs.push({ ...store.runs[0]!, id: legacy, ownerWallet: null });
    for (const call of [list, (id: string, h?: Record<string, string>) => file(id, "patch.diff", h)]) {
      expect((await call(runId, {})).status).toBe(401);
      expect((await call("not-a-uuid")).status).toBe(404);
      expect((await call(randomUUID())).status).toBe(404);
      expect((await call(legacy)).status).toBe(404);
      const other = await call(runId, auth(OTHER));
      expect(other.status).toBe(404);
      expect(await other.json()).toEqual({ error: "run not found" });
    }
  });

  it("the owner lists the patch first, then result.json, then the stored rows in path order, each with an href", async () => {
    const runId = await finishedRun();
    const res = await list(runId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      runId,
      resultOrigin: "hosted",
      limits: LIMITS,
      reason: null,
      artifacts: [
        { path: "patch.diff", contentType: "text/x-diff", kind: "diff", encoding: "utf-8", bytes: Buffer.byteLength(PATCH), sha256: sha(PATCH), href: `/runs/${runId}/artifacts/file?path=patch.diff` },
        { path: "result.json", contentType: "application/json", kind: "json", encoding: "utf-8", bytes: Buffer.byteLength(RESULT), sha256: sha(RESULT), href: `/runs/${runId}/artifacts/file?path=result.json` },
        { path: "agent/trace.jsonl", contentType: "application/x-ndjson", kind: "text", encoding: "utf-8", bytes: 16, sha256: sha('{"type":"step"}\n'), href: `/runs/${runId}/artifacts/file?path=agent%2Ftrace.jsonl` },
        { path: "files/out/chart.png", contentType: "image/png", kind: "image", encoding: "base64", bytes: PNG.length, sha256: sha(PNG), href: `/runs/${runId}/artifacts/file?path=files%2Fout%2Fchart.png` },
        { path: "files/out/report.html", contentType: "text/html", kind: "html", encoding: "utf-8", bytes: Buffer.byteLength(HTML), sha256: sha(HTML), href: `/runs/${runId}/artifacts/file?path=files%2Fout%2Freport.html` },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("escape");
    expect(JSON.stringify(body)).not.toContain("run.sh");
  });

  it("a hosted run with no patch and no stored row lists nothing with reason none_stored", async () => {
    const { runId } = await (await createRun()).json();
    expect(await (await list(runId)).json()).toEqual({ runId, resultOrigin: "hosted", limits: LIMITS, reason: "none_stored", artifacts: [] });
  });

  it("a self-declared run of the owner lists nothing with reason self_declared; a non-owner gets 404; no session gets 401", async () => {
    const runId = await finishedRun();
    lookup.runs.set(runId, { ownerWallet: OWNER, resultOrigin: "self_declared" });
    expect(await (await list(runId)).json()).toEqual({ runId, resultOrigin: "self_declared", limits: LIMITS, reason: "self_declared", artifacts: [] });
    expect((await file(runId, "result.json")).status).toBe(404);
    expect((await list(runId, auth(OTHER))).status).toBe(404);
    expect((await file(runId, "result.json", auth(OTHER))).status).toBe(404);
    expect((await list(runId, {})).status).toBe(401);
    expect((await file(runId, "result.json", {})).status).toBe(401);
  });

  it("the file route answers the bytes as an attachment with the hardening headers", async () => {
    const runId = await finishedRun();
    const res = await file(runId, "files/out/report.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.html"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(HTML)));
    expect(await res.text()).toBe(HTML);
  });

  it("a base64 row comes back as the raw bytes, with the image content type and no charset", async () => {
    const runId = await finishedRun();
    const res = await file(runId, "files/out/chart.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="chart.png"');
    expect(res.headers.get("content-length")).toBe(String(PNG.length));
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(PNG)).toBe(true);
    expect(sha(bytes)).toBe(sha(PNG));
  });

  it("path=patch.diff returns the patch as text/x-diff", async () => {
    const runId = await finishedRun();
    const res = await file(runId, "patch.diff");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-diff; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="patch.diff"');
    expect(await res.text()).toBe(PATCH);
    // a run without a patch: not found
    const { runId: fresh } = await (await createRun()).json();
    expect((await file(fresh, "patch.diff")).status).toBe(404);
  });

  it("400 for a missing or unsafe path; 404 for a path that is not stored or not allowlisted", async () => {
    const runId = await finishedRun();
    for (const bad of [null, "", "../x", "/abs", "a//b", ".env", "files/.git/config", "node_modules/x.json", "files/run.sh?x=1", "artifact:result.json", "a".repeat(201)]) {
      const res = await file(runId, bad);
      expect(res.status, String(bad)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid path" });
    }
    expect((await fetch(`${baseUrl}/runs/${runId}/artifacts/file?path=a.txt&path=b.txt`, { headers: auth(OWNER) })).status).toBe(400);
    for (const missing of ["files/out/missing.html", "files/run.sh", "files/out/chart.PNG"]) {
      const res = await file(runId, missing);
      expect(res.status, missing).toBe(404);
      expect(await res.json()).toEqual({ error: "artifact not found" });
    }
  });

  it("getPatch ignores an artifact row, so the run detail keeps showing the patch", async () => {
    const runId = await finishedRun();
    // the artifact rows were added AFTER the patch row (the runner writes them in the same transaction)
    expect(await store.getPatch(runId)).toBe(PATCH);
    const detail = await (await fetch(`${baseUrl}/runs/${runId}`, { headers: auth(OWNER) })).json();
    expect(detail.patch).toBe(PATCH);
    // a run with ONLY artifact rows has no patch
    const { runId: fresh } = await (await createRun()).json();
    store.addArtifact(fresh, "result.json", RESULT);
    expect(await store.getPatch(fresh)).toBeNull();
    const body = await (await list(fresh)).json();
    expect(body.artifacts.map((a: { path: string }) => a.path)).toEqual(["result.json"]);
    expect(body.reason).toBeNull();
  });

  it("the route list on GET / names both routes", async () => {
    const body = await (await fetch(`${baseUrl}/`)).json();
    expect(body.routes).toContain("GET /runs/:id/artifacts");
    expect(body.routes).toContain("GET /runs/:id/artifacts/file?path=");
  });
});
