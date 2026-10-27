/**
 * DELETE /evaluations/:id (plan 20261026-tma-local-runner-and-self-declared-results, task L19, Q 87769da2 = C)
 * through the real app with the in-memory store. The Postgres twin (one transaction, cascades, FK refusals)
 * is delete.pg.test.ts.
 *
 * Proves: the owner deletes a self-declared evaluation and its runs; another principal gets 404 and the rows
 * stay; no session gets 401; a second delete gets 404; a hosted evaluation gets 409 and stays; a run with a
 * proof gets 409 and stays; an id that is not a uuid gets 404.
 */
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { issueSessionToken } from "../http/auth.js";
import type { EvaluationsConfig } from "./config.js";
import type { PaymentGateway } from "./solana-pay.js";
import { FakeEvaluationsStore } from "./store.fake.js";
import type { EvalRun, EvaluationRecord } from "./store.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = `dfl:${randomUUID()}`;
const BOB = `dfl:${randomUUID()}`;

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

const noPayments = {} as PaymentGateway;

function evaluation(owner: string, over: Partial<EvaluationRecord> = {}): EvaluationRecord {
  const id = randomUUID();
  return {
    id, slug: `sd-${id}`, shortId: id.slice(0, 8), ownerWallet: owner, agentId: randomUUID(), agentVersionId: randomUUID(),
    modelId: "zai/glm-5.3", modelRelease: null,
    tasks: [{ taskId: "t", taskVersionId: null, slug: "t", name: "T", packId: "p", packVersion: "1", isPublic: true }],
    status: "graded", paymentKind: "none", resultOrigin: "self_declared", taskCount: 1, priceUsdPerRun: 0, feeUsd: 0, feeLamports: 0,
    solUsdRate: 0, priceSource: "none", paymentId: null, txSig: null, score: 68.1, passCount: 0, failCount: 1, invalidCount: 0,
    testsPassed: 3, testsTotal: 5, manifestSha256: null, isPublic: false, freeRetriesUsed: 0,
    createdAt: "2026-10-26T12:00:00.000Z", startedAt: null, completedAt: null, issuedAt: null, cancelledAt: null,
    ...over,
  };
}

function run(evaluationId: string, seq = 1): EvalRun {
  return {
    id: seq === 1 ? evaluationId : randomUUID(), evaluationId, seq, taskId: "t", taskVersionId: null, status: "fail", phase: "done", scoreTotal: 68,
    evidenceManifest: null, runStartSig: null, error: null, retryOfRunId: null, startedAt: "2026-10-26T12:00:00.000Z", claimedAt: null, completedAt: null,
  };
}

let server: Server;
let base: string;
let store: FakeEvaluationsStore;

async function del(id: string, principal: string | null) {
  const headers: Record<string, string> = principal ? { Authorization: `Bearer ${issueSessionToken(principal, Date.now(), "dfl").token}` } : {};
  const res = await fetch(`${base}/evaluations/${id}`, { method: "DELETE", headers });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeEach(async () => {
  store = new FakeEvaluationsStore();
  server = createApp(new FakeRepository(), { evaluations: { store, config, price: async () => ({ solUsdRate: 100, priceSource: "pyth", publishedAt: "" }), payments: noPayments } }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("DELETE /evaluations/:id (L19)", () => {
  it("the owner deletes a self-declared evaluation and its runs; a second delete answers 404", async () => {
    const mine = evaluation(ALICE);
    const keep = evaluation(ALICE);
    store.evaluations.push(mine, keep);
    store.runs.push(run(mine.id, 1), run(mine.id, 2), run(keep.id));

    const r = await del(mine.id, ALICE);
    expect(r).toEqual({ status: 200, body: { evaluationId: mine.id, deleted: true, deletedRuns: 2 } });
    expect(store.evaluations.map((e) => e.id)).toEqual([keep.id]);
    expect(store.runs.map((x) => x.evaluationId)).toEqual([keep.id]);

    expect(await del(mine.id, ALICE)).toEqual({ status: 404, body: { error: "evaluation not found" } });
  });

  it("refuses another principal with 404 (the GET convention) and keeps the rows", async () => {
    const mine = evaluation(ALICE);
    store.evaluations.push(mine);
    store.runs.push(run(mine.id));
    expect(await del(mine.id, BOB)).toEqual({ status: 404, body: { error: "evaluation not found" } });
    expect(store.evaluations).toHaveLength(1);
    expect(store.runs).toHaveLength(1);
  });

  it("answers 401 without a session and keeps the rows", async () => {
    const mine = evaluation(ALICE);
    store.evaluations.push(mine);
    store.runs.push(run(mine.id));
    expect((await del(mine.id, null)).status).toBe(401);
    expect(store.evaluations).toHaveLength(1);
    expect(store.runs).toHaveLength(1);
  });

  it("refuses a hosted evaluation of the owner with 409 and keeps it", async () => {
    const hosted = evaluation(ALICE, { resultOrigin: "hosted", paymentKind: "free_byok" });
    const legacy = evaluation(ALICE, { resultOrigin: undefined, paymentKind: undefined });
    store.evaluations.push(hosted, legacy);
    store.runs.push(run(hosted.id));
    for (const e of [hosted, legacy]) {
      expect(await del(e.id, ALICE)).toMatchObject({ status: 409, body: { error: "evaluation_not_deletable", reason: "hosted" } });
    }
    expect(store.evaluations).toHaveLength(2);
    expect(store.runs).toHaveLength(1);
  });

  it("refuses an evaluation whose run has a proof with 409", async () => {
    const mine = evaluation(ALICE);
    store.evaluations.push(mine);
    store.runs.push(run(mine.id));
    store.proofs.push({ runId: mine.id, status: "pending", manifestSha256: null, nftMint: null, txSig: null, attestationAddress: null, error: null, createdAt: "" });
    expect(await del(mine.id, ALICE)).toMatchObject({ status: 409, body: { reason: "has_proofs" } });
    expect(store.evaluations).toHaveLength(1);
  });

  it("answers 404 for an id that is not a uuid", async () => {
    expect((await del("not-a-uuid", ALICE)).status).toBe(404);
  });

  it("is listed on GET /", async () => {
    const res = await fetch(`${base}/`);
    expect(((await res.json()) as { routes: string[] }).routes).toContain("DELETE /evaluations/:id");
  });
});
