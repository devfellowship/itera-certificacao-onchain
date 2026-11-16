/** The human label routes over a fake store (plan 20261112-tma-c6-judge-calibration, T3). */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../auth/session.js";
import {
  createHumanLabelsRouter, humanLabelDigest, labelerOf, queueOrder, type HumanLabel, type HumanLabelStore, type ReasonCode, type ReviewRun, type RunTenant,
} from "./human-labels.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const UUID = "00000000-0000-4000-8000-00000000000a";
const ALICE = `dfl:${UUID}`;
const RUN = "1b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const RUN_OTHER = "2b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const RUN_NO_CASE = "3b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const human = issueSessionToken(ALICE, Date.now(), "dfl", undefined, "human").token;
const agent = issueSessionToken(ALICE, Date.now(), "dfl", undefined, "agent").token;
const siws = issueSessionToken("5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG", Date.now(), "siws").token;

const run = (id: string, over: Partial<ReviewRun>): ReviewRun => ({
  runId: id, caseKey: "c", useCaseKey: "build/feature", originPinSha256: null, taskSummary: null, modelId: null, status: "pass",
  startedAt: "2026-11-15T10:00:00.000Z", steps: [], judge: null, workflow: null, mine: null, disagree: false, ...over,
});

class FakeStore implements HumanLabelStore {
  isReady = true;
  rows: HumanLabel[] = [];
  queueArgs: unknown[] = [];
  async ready() {
    return this.isReady;
  }
  async runTenant(id: string): Promise<RunTenant> {
    if (id === RUN) return { tenant: "devfellowship" };
    if (id === RUN_OTHER) return { tenant: "other-tenant" };
    if (id === RUN_NO_CASE) return { tenant: null };
    return null;
  }
  async insert(r: { tenant: string; runId: string; judgeId: string; pass: boolean; reasonCode: ReasonCode | null; labeler: string }) {
    const row = { id: `l${this.rows.length}`, runId: r.runId, judgeId: r.judgeId, pass: r.pass, reasonCode: r.reasonCode, labeler: r.labeler, gradedAt: "2026-11-16T00:00:00.000Z" };
    this.rows.push(row);
    return row;
  }
  async labels(runId: string) {
    return this.rows.filter((r) => r.runId === runId);
  }
  async queue(...args: unknown[]) {
    this.queueArgs = args;
    return [run(RUN, {})];
  }
}

let server: Server;
let base = "";
let store: FakeStore;
beforeEach(async () => {
  store = new FakeStore();
  const app = express();
  app.use(express.json());
  app.use(createHumanLabelsRouter({ store, tenant: "devfellowship" }));
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
};
const label = (over: Record<string, unknown> = {}) => ({ run_id: RUN, judge_id: "async-wait-lifecycle", pass: false, reason_code: "other", ...over });

describe("POST /grader-results/human", () => {
  it("writes one label with the caller as labeler and reads it back", async () => {
    const w = await call("POST", "/grader-results/human", human, label());
    expect(w.status).toBe(201);
    expect(w.json).toMatchObject({ runId: RUN, judgeId: "async-wait-lifecycle", pass: false, reasonCode: "other", labeler: `person:${UUID}` });
    const r = await call("GET", `/grader-results/human?run_id=${RUN}`, human);
    expect(r.status).toBe(200);
    expect(r.json.labels).toHaveLength(1);
    expect(r.json.labels[0].id).toBe(w.json.id);
  });
  it("marks an agent login as agent:, never person:", async () => {
    const w = await call("POST", "/grader-results/human", agent, label({ reason_code: null, pass: true }));
    expect(w.status).toBe(201);
    expect(w.json.labeler).toBe(`agent:${UUID}`);
  });
  it("answers 403 for a run of another tenant and writes nothing", async () => {
    expect(await call("POST", "/grader-results/human", human, label({ run_id: RUN_OTHER }))).toMatchObject({ status: 403, json: { error: "run_other_tenant" } });
    expect(await call("GET", `/grader-results/human?run_id=${RUN_OTHER}`, human)).toMatchObject({ status: 403 });
    expect(store.rows).toHaveLength(0);
  });
  it("answers 404 for an unknown or malformed run and 409 for a run with no case", async () => {
    expect((await call("POST", "/grader-results/human", human, label({ run_id: "4b6f3c2e-1d4a-4c8e-9f00-123456789abc" }))).status).toBe(404);
    expect((await call("POST", "/grader-results/human", human, label({ run_id: "x" }))).status).toBe(404);
    expect(await call("POST", "/grader-results/human", human, label({ run_id: RUN_NO_CASE }))).toMatchObject({ status: 409, json: { error: "run_has_no_case" } });
  });
  it("refuses an unknown key, an unknown judge, a non-boolean pass and a free-text reason", async () => {
    expect(await call("POST", "/grader-results/human", human, label({ note: "free text" }))).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await call("POST", "/grader-results/human", human, label({ judge_id: "made-up" }))).toMatchObject({ status: 400, json: { error: "unknown_judge" } });
    expect((await call("POST", "/grader-results/human", human, label({ pass: "yes" }))).status).toBe(400);
    expect((await call("POST", "/grader-results/human", human, label({ reason_code: "it was slow" }))).status).toBe(400);
    expect(store.rows).toHaveLength(0);
  });
  it("answers 401 without a session, 403 for siws and 503 before 0024", async () => {
    expect((await call("POST", "/grader-results/human", undefined, label())).status).toBe(401);
    expect(await call("POST", "/grader-results/human", siws, label())).toMatchObject({ status: 403, json: { error: "not_a_dfl_login" } });
    store.isReady = false;
    expect(await call("POST", "/grader-results/human", human, label())).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
  });
});

describe("GET /review-queue", () => {
  it("passes the tenant, judge, caller and capped limit to the store", async () => {
    const r = await call("GET", "/review-queue?judge=external-block-handling&limit=999", human);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ judge: "external-block-handling", runs: [{ runId: RUN }] });
    expect(store.queueArgs).toEqual(["devfellowship", "external-block-handling", `person:${UUID}`, 200]);
  });
  it("refuses an unknown judge and a bad limit", async () => {
    expect((await call("GET", "/review-queue?judge=x", human)).status).toBe(400);
    expect((await call("GET", "/review-queue?judge=async-wait-lifecycle&limit=0", human)).status).toBe(400);
  });
});

describe("helpers", () => {
  it("humanLabelDigest is the kit's humanGraderDigest rule", () => {
    // sha256("tma-human-label/1\nlabel-async-wait-lifecycle@1.0.0"), the value services/runner humanGraderDigest gives.
    expect(humanLabelDigest("label-async-wait-lifecycle", "1.0.0")).toBe("3e263c0a566a278f705d1b1baf227a17bf214973f6c7434c332b201afb874b09");
    expect(humanLabelDigest("a", "0.0.0")).not.toBe(humanLabelDigest("b", "0.0.0"));
  });
  it("labelerOf is fail closed", () => {
    expect(labelerOf({ id: ALICE, kind: "dfl", actorType: "unknown" })).toBe(`user:${UUID}`);
  });
  it("queueOrder puts disagreements first, then unlabeled, then newest", () => {
    const v = { pass: true, labeler: null, gradedAt: "x" };
    const out = queueOrder([
      run("a", { startedAt: "2026-11-15T12:00:00.000Z", mine: v }),
      run("b", { startedAt: "2026-11-15T09:00:00.000Z" }),
      run("c", { startedAt: "2026-11-15T08:00:00.000Z", disagree: true }),
      run("d", { startedAt: "2026-11-15T11:00:00.000Z" }),
    ]);
    expect(out.map((r) => r.runId)).toEqual(["c", "d", "b", "a"]);
  });
});
