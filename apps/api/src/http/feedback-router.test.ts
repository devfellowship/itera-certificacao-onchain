import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeReputationStore, type RunProvenance } from "../domain/reputation-store.js";
import { issueSessionToken } from "./auth.js";
import { createFeedbackRouter } from "./feedback-router.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const OWNER = "So11111111111111111111111111111111111111112";
const AUTHOR = "Vote111111111111111111111111111111111111111";
const RUN = "11111111-1111-4111-8111-111111111111";
const RUN_RUNNING = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";

const store = new FakeReputationStore();
const prov = (runId: string, status: string): RunProvenance => ({
  runId,
  runOwnerWallet: OWNER,
  runStatus: status,
  taskId: TASK,
  task: { kind: "user", authorWallet: AUTHOR, source: "github", repoPrivate: true, labels: [], githubAccount: "alice" },
  agent: { ownerWallet: OWNER, githubAccount: "bob" },
});
store.provenance.set(RUN, prov(RUN, "pass"));
store.provenance.set(RUN_RUNNING, prov(RUN_RUNNING, "running"));
store.inputs.set(TASK, { taskId: TASK, slug: "my-task", ownerWallet: AUTHOR, kind: "user", distinctWallets: 5, runs: 9, feedbackYes: 0, feedbackTotal: 0 });

let base = "";
let close: () => void;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createFeedbackRouter({ store }));
  await new Promise<void>((resolve) => {
    const srv = app.listen(0, () => {
      base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      close = () => srv.close();
      resolve();
    });
  });
});
afterAll(() => close());

const post = (runId: string, wallet: string | null, body: unknown) =>
  fetch(`${base}/runs/${runId}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(wallet ? { authorization: `Bearer ${issueSessionToken(wallet).token}` } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /runs/:id/feedback (U27)", () => {
  it("rejects anonymous, non-owner, bad body and an unfinished run", async () => {
    expect((await post(RUN, null, { matchedReality: true })).status).toBe(401);
    expect((await post(RUN, AUTHOR, { matchedReality: true })).status).toBe(403);
    expect((await post(RUN, OWNER, { matchedReality: "yes" })).status).toBe(400);
    expect((await post(RUN, OWNER, { matchedReality: true, note: "x".repeat(501) })).status).toBe(400);
    expect((await post(RUN_RUNNING, OWNER, { matchedReality: true })).status).toBe(409);
    expect((await post("44444444-4444-4444-8444-444444444444", OWNER, { matchedReality: true })).status).toBe(404);
  });

  it("stores one answer per run and the task reputation updates", async () => {
    const before = await (await fetch(`${base}/tasks/${TASK}/reputation`, { headers: { authorization: `Bearer ${issueSessionToken(AUTHOR).token}` } })).json();
    expect(before.feedbackCount).toBe(0);
    expect(before.weight).toBe(0.5);
    const res = await post(RUN, OWNER, { matchedReality: true, note: " looked right " });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.feedback).toMatchObject({ runId: RUN, wallet: OWNER, taskId: TASK, matchedReality: true, note: "looked right" });
    expect(body.taskReputation).toMatchObject({ feedbackCount: 1, feedbackYesRate: 1, weight: 0.667 });
    const again = await post(RUN, OWNER, { matchedReality: false });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("already_answered");
    const read = await (await fetch(`${base}/runs/${RUN}/feedback`, { headers: { authorization: `Bearer ${issueSessionToken(OWNER).token}` } })).json();
    expect(read.feedback.matchedReality).toBe(true);
    expect(read.canAnswer).toBe(false);
    expect(read.provenance).toMatchObject({ taskAuthorWallet: AUTHOR, agentOwnerWallet: OWNER, selfEvaluated: false, ranked: true });
  });

  it("a user task's reputation is visible to its author only", async () => {
    expect((await fetch(`${base}/tasks/my-task/reputation`)).status).toBe(404);
    expect((await fetch(`${base}/tasks/my-task/reputation`, { headers: { authorization: `Bearer ${issueSessionToken(AUTHOR).token}` } })).status).toBe(200);
  });
});
