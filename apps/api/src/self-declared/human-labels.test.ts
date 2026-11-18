/** The human label routes over a fake store (plan 20261112-tma-c6-judge-calibration, T3). */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../auth/session.js";
import {
  createHumanLabelsRouter, displayKind, progressCounts, humanLabelDigest, labelerOf, labelStrength, queueOrder, splitOf, taskIdOfSlug, type HumanLabel, type StepDetail, type HumanLabelStore, type ReasonCode, type ReviewRun, type RunTenant,
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
  startedAt: "2026-11-15T10:00:00.000Z", steps: [], judge: null, workflow: null, mine: null, disagree: false, split: null, ...over,
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
  caseRunsArgs: unknown[] = [];
  async caseRuns(tenant: string, caseKey: string) {
    this.caseRunsArgs = [tenant, caseKey];
    return caseKey === "trace-4da84c52-a423a4c8" ? [{ runId: RUN, startedAt: "2026-11-15T10:00:00.000Z" }] : [];
  }
  stepsFor: string[] = [];
  async steps(runId: string): Promise<StepDetail[]> {
    this.stepsFor.push(runId);
    return [
      { seq: 1, tool: "Bash", target: "gh pr view", kind: "shell", status: "ok", errorClass: null, durationMs: 1200, startedMs: 0, turnOrigin: "agent" },
      { seq: 2, tool: "Bash", target: "sleep", kind: "shell", status: "ok", errorClass: null, durationMs: 600000, startedMs: 5000, turnOrigin: "agent" },
    ];
  }
  async queue(...args: unknown[]) {
    this.queueArgs = args;
    return [run(RUN, {})];
  }
  progressArgs: unknown[] = [];
  personRows: Array<{ taskSlug: string | null; pass: boolean }> = [];
  async personLabels(...args: unknown[]) {
    this.progressArgs = args;
    return this.personRows;
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

describe("POST /grader-results/human with workflow_signal (C6-T2, Q-C6-T2 = A)", () => {
  const wf = (over: Record<string, unknown> = {}) => label({ pass: true, reason_code: "other", workflow_signal: "clean-merge", ...over });
  it("an agent login writes a weak workflow pass label with labeler workflow:<signal> and its reason_code", async () => {
    const w = await call("POST", "/grader-results/human", agent, wf());
    expect(w.status).toBe(201);
    expect(w.json).toMatchObject({ runId: RUN, judgeId: "async-wait-lifecycle", pass: true, reasonCode: "other", labeler: "workflow:clean-merge", strength: "weak" });
    const r = await call("GET", `/grader-results/human?run_id=${RUN}`, human);
    expect(r.json.labels).toEqual([expect.objectContaining({ labeler: "workflow:clean-merge", reasonCode: "other", strength: "weak" })]);
  });
  it("is idempotent per run, judge and signal: the same label again answers 200 unchanged and writes no row", async () => {
    const a = await call("POST", "/grader-results/human", agent, wf());
    const b = await call("POST", "/grader-results/human", agent, wf());
    expect(b.status).toBe(200);
    expect(b.json).toMatchObject({ id: a.json.id, unchanged: true });
    // The other judge is another label.
    expect((await call("POST", "/grader-results/human", agent, wf({ judge_id: "external-block-handling" }))).status).toBe(201);
    expect(store.rows).toHaveLength(2);
  });
  it("refuses a person login, a fail, a missing reason_code and an unknown signal, and writes nothing", async () => {
    expect(await call("POST", "/grader-results/human", human, wf())).toMatchObject({ status: 403, json: { error: "workflow_label_needs_agent" } });
    expect(await call("POST", "/grader-results/human", agent, wf({ pass: false }))).toMatchObject({ status: 400, json: { error: "workflow_label_pass_only" } });
    expect(await call("POST", "/grader-results/human", agent, wf({ reason_code: null }))).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await call("POST", "/grader-results/human", agent, wf({ reason_code: undefined }))).toMatchObject({ status: 400 });
    expect(await call("POST", "/grader-results/human", agent, wf({ workflow_signal: "merged" }))).toMatchObject({ status: 400, json: { error: "unknown_signal" } });
    expect(await call("POST", "/grader-results/human", agent, wf({ workflow_signal: "__proto__" }))).toMatchObject({ status: 400, json: { error: "unknown_signal" } });
    expect(await call("POST", "/grader-results/human", agent, wf({ workflow_signal: 1 }))).toMatchObject({ status: 400, json: { error: "unknown_signal" } });
    expect(await call("POST", "/grader-results/human", agent, wf({ run_id: RUN_OTHER }))).toMatchObject({ status: 403, json: { error: "run_other_tenant" } });
    expect(store.rows).toHaveLength(0);
  });
  it("a person label and an agent label carry strength strong and null", async () => {
    expect((await call("POST", "/grader-results/human", human, label())).json.strength).toBe("strong");
    expect((await call("POST", "/grader-results/human", agent, label({ pass: true }))).json.strength).toBeNull();
  });
});

describe("GET /review-queue/runs", () => {
  it("lists the runs of one case of the tenant", async () => {
    const r = await call("GET", "/review-queue/runs?case_key=trace-4da84c52-a423a4c8", agent);
    expect(r).toMatchObject({ status: 200, json: { case_key: "trace-4da84c52-a423a4c8", runs: [{ run_id: RUN, started_at: "2026-11-15T10:00:00.000Z" }] } });
    expect(store.caseRunsArgs).toEqual(["devfellowship", "trace-4da84c52-a423a4c8"]);
    expect((await call("GET", "/review-queue/runs?case_key=unknown-case", agent)).json.runs).toEqual([]);
  });
  it("refuses a bad case key, a siws login and no session", async () => {
    expect((await call("GET", "/review-queue/runs?case_key=Bad%20Key", agent)).status).toBe(400);
    expect((await call("GET", "/review-queue/runs", agent)).status).toBe(400);
    expect((await call("GET", "/review-queue/runs?case_key=trace-4da84c52-a423a4c8", siws)).status).toBe(403);
    expect((await call("GET", "/review-queue/runs?case_key=trace-4da84c52-a423a4c8")).status).toBe(401);
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

/** A recorded task id whose split for the judge is `want` (the dfl-evals rule), found by a fixed scan. */
const taskIn = (judge: string, want: string, from = 0): string => {
  for (let i = from; i < 1000; i++) if (splitOf(judge, `t${i}x`) === want) return `t${i}x`;
  throw new Error(`no task in ${want}`);
};

describe("GET /review-queue/progress", () => {
  it("counts the person labels per split and verdict for the judge, with the floor of 30", async () => {
    const J = "async-wait-lifecycle";
    const t1 = taskIn(J, "test");
    const t2 = taskIn(J, "test", Number(t1.slice(1, -1)) + 1);
    const d1 = taskIn(J, "dev");
    store.personRows = [
      { taskSlug: `dfl-task-${t1}`, pass: true },
      { taskSlug: `dfl-task-${t2}`, pass: false },
      { taskSlug: `tma-task-${t1}`, pass: true },
      { taskSlug: `dfl-task-${d1}`, pass: false },
      { taskSlug: "studio-review-fixture-task", pass: true },
      { taskSlug: null, pass: false },
    ];
    const r = await call("GET", `/review-queue/progress?judge=${J}`, human);
    expect(r.status).toBe(200);
    expect(store.progressArgs).toEqual(["devfellowship", J]);
    expect(r.json).toEqual({
      judge: J, floor: 30,
      splits: { test: { pass: 2, fail: 1 }, dev: { pass: 0, fail: 1 }, train: { pass: 0, fail: 0 }, unknown: { pass: 1, fail: 1 } },
    });
  });
  it("refuses an unknown judge and a siws login, and answers 503 before 0024", async () => {
    expect((await call("GET", "/review-queue/progress?judge=x", human)).status).toBe(400);
    expect((await call("GET", "/review-queue/progress?judge=async-wait-lifecycle", siws)).status).toBe(403);
    store.isReady = false;
    expect((await call("GET", "/review-queue/progress?judge=async-wait-lifecycle", human)).status).toBe(503);
  });
  it("progressCounts uses the split of the judge, not of another judge", () => {
    const t = taskIn("async-wait-lifecycle", "test");
    const other = splitOf("external-block-handling", t);
    const c = progressCounts("external-block-handling", [{ taskSlug: `dfl-task-${t}`, pass: true }]);
    expect(c[other].pass).toBe(1);
  });
});

describe("helpers", () => {
  it("humanLabelDigest is the kit's humanGraderDigest rule", () => {
    // sha256("tma-human-label/1\nlabel-async-wait-lifecycle@1.0.0"), the value services/runner humanGraderDigest gives.
    expect(humanLabelDigest("label-async-wait-lifecycle", "1.0.0")).toBe("3e263c0a566a278f705d1b1baf227a17bf214973f6c7434c332b201afb874b09");
    expect(humanLabelDigest("a", "0.0.0")).not.toBe(humanLabelDigest("b", "0.0.0"));
  });
  it("labelStrength: person strong, a known workflow signal its strength, anything else null", () => {
    expect(labelStrength(`person:${UUID}`)).toBe("strong");
    expect(labelStrength("workflow:clean-merge")).toBe("weak");
    expect(labelStrength("workflow:reverted")).toBeNull();
    expect(labelStrength(`agent:${UUID}`)).toBeNull();
    expect(labelStrength(null)).toBeNull();
  });
  it("labelerOf is fail closed", () => {
    expect(labelerOf({ id: ALICE, kind: "dfl", actorType: "unknown" })).toBe(`user:${UUID}`);
  });
  it("queueOrder puts the test split first, then dev, train and unknown; inside a split disagreements, unlabeled, newest", () => {
    const out = queueOrder([
      run("u", { startedAt: "2026-11-15T20:00:00.000Z", split: null }),
      run("tr", { startedAt: "2026-11-15T19:00:00.000Z", split: "train", disagree: true }),
      run("dv", { startedAt: "2026-11-15T18:00:00.000Z", split: "dev", disagree: true }),
      run("t-old", { startedAt: "2026-11-15T01:00:00.000Z", split: "test" }),
      run("t-new", { startedAt: "2026-11-15T02:00:00.000Z", split: "test" }),
      run("t-dis", { startedAt: "2026-11-15T00:00:00.000Z", split: "test", disagree: true }),
    ]);
    expect(out.map((r) => r.runId)).toEqual(["t-dis", "t-new", "t-old", "dv", "tr", "u"]);
  });
  it("splitOf is the dfl-evals calibration_split.py rule (vectors from ci/calibration_split.py assign, seed 20261112, 20/40/40)", () => {
    const vectors: Array<[string, string, string]> = [["async-wait-lifecycle", "6adaacbe-fa3c-41be-8c46-b319dc1e5ff0", "test"], ["async-wait-lifecycle", "6adaacbe-fa3c-41be-8c46-b319dc1e5ff2", "dev"], ["async-wait-lifecycle", "6adaacbe-fa3c-41be-8c46-b319dc1e5ff4", "train"], ["async-wait-lifecycle", "6adaacbe-fa3c-41be-8c46-b319dc1e5ff7", "train"], ["external-block-handling", "6adaacbe-fa3c-41be-8c46-b319dc1e5ff0", "dev"], ["external-block-handling", "6adaacbe-fa3c-41be-8c46-b319dc1e5ff3", "test"], ["external-block-handling", "6adaacbe-fa3c-41be-8c46-b319dc1e5ff7", "dev"]];
    for (const [judge, task, want] of vectors) expect(splitOf(judge, task)).toBe(want);
    // another seed moves at least one task (the seed is part of the key)
    expect(vectors.some(([judge, task, want]) => splitOf(judge, task, "7") !== want)).toBe(true);
    // the split is per judge: one task is not in the same part for both judges
    expect(splitOf("async-wait-lifecycle", "6adaacbe-fa3c-41be-8c46-b319dc1e5ff0")).not.toBe(splitOf("external-block-handling", "6adaacbe-fa3c-41be-8c46-b319dc1e5ff0"));
  });
  it("taskIdOfSlug reads the recorded task slug of review-batch and nothing else", () => {
    expect(taskIdOfSlug("dfl-task-6adaacbe-fa3c-41be-8c46-b319dc1e5ff0")).toBe("6adaacbe-fa3c-41be-8c46-b319dc1e5ff0");
    expect(taskIdOfSlug("tma-task-abc")).toBe("abc");
    expect(taskIdOfSlug("task-0123456789abcdef")).toBeNull();
    expect(taskIdOfSlug("")).toBeNull();
    expect(taskIdOfSlug(null)).toBeNull();
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

describe("displayKind", () => {
  it("keeps a stored kind and derives the others from the tool and the redacted target", () => {
    expect(displayKind("test", "Bash", "ls")).toBe("test");
    expect(displayKind(null, "Read", "lib/add.js")).toBe("read");
    expect(displayKind(null, "Edit", "lib/add.js")).toBe("write");
    expect(displayKind(null, "Write", "lib/add.js")).toBe("write");
    expect(displayKind(null, "Grep", "foo")).toBe("search");
    expect(displayKind(null, "Bash", "npm run test")).toBe("test");
    expect(displayKind(null, "Bash", "git commit")).toBe("write");
    expect(displayKind(null, "Bash", "gh pr view")).toBe("shell");
    expect(displayKind(null, "mcp__dfl__get_plan", null)).toBe("mcp");
    expect(displayKind(null, "Skill", "plan-tasks")).toBe("mcp");
    expect(displayKind(null, "Agent", null)).toBe("agent");
    expect(displayKind(null, "Monitor", null)).toBe("other");
  });
});

describe("GET /review-queue/steps", () => {
  it("returns the redacted steps of a run of the tenant, in order, with the timing fields", async () => {
    const r = await call("GET", `/review-queue/steps?run_id=${RUN}`, human);
    expect(r.status).toBe(200);
    expect(r.json.run_id).toBe(RUN);
    expect(r.json.steps.map((s: StepDetail) => s.seq)).toEqual([1, 2]);
    expect(r.json.steps[1]).toMatchObject({ tool: "Bash", target: "sleep", durationMs: 600000, startedMs: 5000 });
    expect(Object.keys(r.json.steps[0]).sort()).toEqual(["durationMs", "errorClass", "kind", "seq", "startedMs", "status", "target", "tool", "turnOrigin"]);
  });
  it("refuses a run of another tenant (403), a run with no case (409), an unknown or malformed id (404), a siws login (403)", async () => {
    expect((await call("GET", `/review-queue/steps?run_id=${RUN_OTHER}`, human)).status).toBe(403);
    expect((await call("GET", `/review-queue/steps?run_id=${RUN_NO_CASE}`, human)).status).toBe(409);
    expect((await call("GET", `/review-queue/steps?run_id=4b6f3c2e-1d4a-4c8e-9f00-123456789abc`, human)).status).toBe(404);
    expect((await call("GET", `/review-queue/steps?run_id=nope`, human)).status).toBe(404);
    expect((await call("GET", `/review-queue/steps?run_id=${RUN}`, siws)).status).toBe(403);
    expect((await call("GET", `/review-queue/steps?run_id=${RUN}`)).status).toBe(401);
    expect(store.stepsFor).toEqual([]);
  });
});
