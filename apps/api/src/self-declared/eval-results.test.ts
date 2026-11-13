/**
 * The eval-results read side over a fake reader (plan 20261112-tma-c4-result-store-trajectory-upload, T3, T8). The pg
 * reader has its own test (store-v2.pg.test.ts). Proves: GET /evaluations/:id and GET /runs/:id get case, variant,
 * graders and trajectory summary on a success body only; before 0023 (reader not ready) the bodies are unchanged
 * and GET /eval-cases/:id answers 503; GET /eval-cases/:id is owner-only (404 for another principal).
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../auth/session.js";
import {
  createEvalResultsRouter, EVAL_CASES_LIMIT, EVAL_RUNS_LIMIT, graderSummaries, type EvalCaseDetail, type EvalCaseListItem, type EvalResultsReader,
  type EvalRunRow, type EvalRunsFilter, type RunEvalResults,
} from "./eval-results.js";
import { trajectorySummaryOf } from "./store.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const BOB = "dfl:00000000-0000-4000-8000-00000000000b";
const EVAL = "5b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const RUN1 = "6b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const RUN2 = "7b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const CASE = "8b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const H = (c: string) => c.repeat(64);
const dfl = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;

const VARIANT = "9b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const AGENT = "ab6f3c2e-1d4a-4c8e-9f00-123456789abc";
const kase = {
  id: CASE, caseKey: "webhook-dup-001", manifestSha256: H("1"), originPinSha256: H("2"), mode: "replay" as const, useCaseKey: "fix/prod-bug",
  taskId: null, baselineVariantId: VARIANT, taskSummary: null, createdAt: "2026-11-12T12:00:00.000Z",
};
const agent = {
  harness: "claude-code", harnessVersion: "2.1.87", harnessRepoSha: "0".repeat(40), modelId: "zai/glm-5.3",
  rulesSha256: H("6"), skillsSha256: H("7"), mcpManifestSha256: null, toolsSha256: null,
};
const variant = { id: VARIANT, agentSha256: H("8"), agent, variantSha256: H("5"), label: "baseline", changeKind: "none", isBaseline: true };
const grade = (pass: boolean, score: number, gradedAt: string) => ({
  id: "hidden-tests", semver: "2.0.0", kind: "code", codeSha256: H("f"), pass, score, weight: 1, hardGate: true, decisive: true, infraOk: true,
  reasonCode: null, labeler: null, proof: { caught: 3, total: 3 }, calibration: null, note: "v2", author: "claude-main", gradedAt,
});

class FakeReader implements EvalResultsReader {
  isReady = true;
  results = new Map<string, RunEvalResults>([
    [RUN1, { graders: [grade(true, 100, "2026-11-12T12:01:00.000Z")], trajectorySummary: { steps: 3, firstFailureSeq: 2, errorClasses: { tool_error: 1 } } }],
    // A re-grade: the latest row counts in the summary.
    [RUN2, { graders: [grade(false, 80, "2026-11-12T12:01:00.000Z"), grade(true, 100, "2026-11-12T12:05:00.000Z")], trajectorySummary: null }],
  ]);
  async ready() {
    return this.isReady;
  }
  async caseOfEvaluation(id: string) {
    return id === EVAL ? { case: kase, variant, predictionSha256: null } : null;
  }
  async caseOfRun(id: string) {
    return id === RUN1 || id === RUN2 ? { case: kase, variant, predictionSha256: null } : null;
  }
  async runIdsOf(id: string) {
    return id === EVAL ? [RUN1, RUN2] : [];
  }
  async resultsOfRuns(ids: string[]) {
    return new Map(ids.map((id) => [id, this.results.get(id) ?? { graders: [], trajectorySummary: null }]));
  }
  async caseDetail(id: string, owner: string): Promise<EvalCaseDetail | null> {
    if (id !== CASE || owner !== ALICE) return null;
    return {
      ...kase, taskSlug: "webhook-dup", graders: [{ id: "hidden-tests", semver: "2.0.0", kind: "code" }],
      variants: [{ ...variant, predictionSha256: null, n: 2, pass: 2, fail: 0, infraErrors: 0, passRate: 1, meanScore: 100, evaluationIds: [EVAL] }],
    };
  }
  /** Every case of every owner; listCases filters by owner as the pg reader does. */
  cases: Array<EvalCaseListItem & { owner: string }> = [
    { ...kase, taskSlug: "webhook-dup", variantCount: 1, runCount: 2, lastRunAt: "2026-11-12T12:01:00.000Z", owner: ALICE },
  ];
  runs: Array<EvalRunRow & { owner: string }> = [RUN1, RUN2].map((id, i) => ({
    id, evaluationId: EVAL, agentId: AGENT, agentName: "alpha", seq: i + 1, status: "pass", score: 100, infraOk: true,
    startedAt: "2026-11-12T12:01:00.000Z", caseId: CASE, caseKey: kase.caseKey, useCaseKey: kase.useCaseKey, variant, predictionSha256: null, owner: ALICE,
  }));
  lastLimit = 0;
  lastFilter: EvalRunsFilter | null = null;
  async listCases(owner: string, limit: number) {
    this.lastLimit = limit;
    return this.cases.filter((c) => c.owner === owner).slice(0, limit).map(({ owner: _o, ...c }) => c);
  }
  async listRuns(owner: string, filter: EvalRunsFilter, limit: number) {
    this.lastLimit = limit;
    this.lastFilter = filter;
    return this.runs
      .filter((r) => r.owner === owner && (!filter.agentId || r.agentId === filter.agentId) && (!filter.caseId || r.caseId === filter.caseId))
      .slice(0, limit)
      .map(({ owner: _o, ...r }) => r);
  }
}

let server: Server;
let base = "";
let reader: FakeReader;

beforeEach(async () => {
  reader = new FakeReader();
  const app = express();
  app.use(createEvalResultsRouter(reader));
  // Stand-ins for the real routers: the evaluation view (tasks[] with runId), a run view, and their 404s.
  app.get("/evaluations/:id", (req, res) => {
    if (req.params.id !== EVAL) return void res.status(404).json({ error: "evaluation not found" });
    res.json({ id: EVAL, status: "graded", tasks: [{ runId: RUN1, seq: 1 }, { runId: RUN2, seq: 2 }] });
  });
  app.get("/runs/:id", (req, res) => {
    if (req.params.id !== RUN1) return void res.status(404).json({ error: "run not found" });
    res.json({ id: RUN1, status: "pass" });
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const get = async (path: string, token?: string) => {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: (await res.json()) as any };
};

describe("eval results on the read routes", () => {
  it("adds case, variant, grader summaries and per-run graders and trajectory summary to GET /evaluations/:id", async () => {
    const r = await get(`/evaluations/${EVAL}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: EVAL, status: "graded", case: kase, variant, predictionSha256: null });
    expect(r.json.variant.agent).toEqual(agent);
    expect(r.json.graders).toEqual([{ id: "hidden-tests", semver: "2.0.0", kind: "code", codeSha256: H("f"), n: 2, pass: 2, meanScore: 100, hardGate: true, decisive: true, proof: { caught: 3, total: 3 }, calibration: null, note: "v2", author: "claude-main" }]);
    expect(r.json.tasks[0]).toMatchObject({ runId: RUN1, seq: 1, trajectorySummary: { steps: 3, firstFailureSeq: 2, errorClasses: { tool_error: 1 } } });
    expect(r.json.tasks[1].graders).toHaveLength(2);
  });

  it("adds case, variant, graders and trajectory summary to GET /runs/:id", async () => {
    const r = await get(`/runs/${RUN1}`);
    expect(r.json).toMatchObject({ id: RUN1, case: { id: CASE }, variant: { isBaseline: true }, trajectorySummary: { steps: 3 } });
    expect(r.json.graders).toHaveLength(1);
  });

  it("never decorates an error body", async () => {
    const other = "0b6f3c2e-1d4a-4c8e-9f00-123456789abc";
    expect(await get(`/evaluations/${other}`)).toEqual({ status: 404, json: { error: "evaluation not found" } });
    expect(await get(`/runs/${RUN2}`)).toEqual({ status: 404, json: { error: "run not found" } });
  });

  it("leaves the bodies unchanged before 0023 and answers 503 on GET /eval-cases/:id", async () => {
    reader.isReady = false;
    expect((await get(`/evaluations/${EVAL}`)).json).toEqual({ id: EVAL, status: "graded", tasks: [{ runId: RUN1, seq: 1 }, { runId: RUN2, seq: 2 }] });
    expect((await get(`/runs/${RUN1}`)).json).toEqual({ id: RUN1, status: "pass" });
    expect(await get(`/eval-cases/${CASE}`, dfl(ALICE))).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
  });
});

describe("GET /eval-cases/:id", () => {
  it("lists the variants with n, pass rate and the baseline to the owner", async () => {
    const r = await get(`/eval-cases/${CASE}`, dfl(ALICE));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: CASE, baselineVariantId: variant.id, variants: [{ id: variant.id, n: 2, passRate: 1, isBaseline: true, evaluationIds: [EVAL] }] });
    expect(r.json).toMatchObject({ taskSlug: "webhook-dup", graders: [{ id: "hidden-tests", semver: "2.0.0", kind: "code" }] });
  });

  it("answers 401 without a session, and the same 404 for another principal and an unknown id", async () => {
    expect((await get(`/eval-cases/${CASE}`)).status).toBe(401);
    expect(await get(`/eval-cases/${CASE}`, dfl(BOB))).toEqual({ status: 404, json: { error: "eval case not found" } });
    expect(await get("/eval-cases/not-a-uuid", dfl(ALICE))).toEqual({ status: 404, json: { error: "eval case not found" } });
  });
});

describe("GET /eval-cases (C5-T3)", () => {
  it("lists the caller's cases with counts and the cap", async () => {
    const r = await get("/eval-cases", dfl(ALICE));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      cases: [{ ...kase, taskSlug: "webhook-dup", variantCount: 1, runCount: 2, lastRunAt: "2026-11-12T12:01:00.000Z" }],
      limit: EVAL_CASES_LIMIT,
      truncated: false,
    });
    // One row more than the cap is asked for, to know whether the list is truncated.
    expect(reader.lastLimit).toBe(EVAL_CASES_LIMIT + 1);
  });

  it("answers 401 without a session, an empty list to another principal, and 503 before 0023", async () => {
    expect((await get("/eval-cases")).status).toBe(401);
    expect(await get("/eval-cases", dfl(BOB))).toEqual({ status: 200, json: { cases: [], limit: EVAL_CASES_LIMIT, truncated: false } });
    reader.isReady = false;
    expect(await get("/eval-cases", dfl(ALICE))).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
  });

  it("says truncated when there are more cases than the cap", async () => {
    reader.cases = Array.from({ length: EVAL_CASES_LIMIT + 5 }, (_, i) => ({ ...reader.cases[0]!, id: `${i}`, caseKey: `c-${i}` }));
    const r = await get("/eval-cases", dfl(ALICE));
    expect(r.json.cases).toHaveLength(EVAL_CASES_LIMIT);
    expect(r.json.truncated).toBe(true);
  });

  it("is GET only: no write route on /eval-cases", async () => {
    const res = await fetch(`${base}/eval-cases`, { method: "POST", headers: { authorization: `Bearer ${dfl(ALICE)}` } });
    expect(res.status).toBe(404);
  });
});

describe("GET /eval-runs (C5-T3)", () => {
  it("lists the caller's uploaded runs with case, variant, evaluation and agent", async () => {
    const r = await get("/eval-runs", dfl(ALICE));
    expect(r.status).toBe(200);
    expect(r.json.limit).toBe(EVAL_RUNS_LIMIT);
    expect(r.json.truncated).toBe(false);
    expect(r.json.runs).toHaveLength(2);
    expect(r.json.runs[0]).toMatchObject({ id: RUN1, evaluationId: EVAL, agentId: AGENT, caseId: CASE, caseKey: kase.caseKey, variant: { id: VARIANT, isBaseline: true } });
    expect(reader.lastLimit).toBe(EVAL_RUNS_LIMIT + 1);
  });

  it("passes the agent and case filters to the reader", async () => {
    expect((await get(`/eval-runs?agent=${AGENT}&case=${CASE}`, dfl(ALICE))).json.runs).toHaveLength(2);
    expect(reader.lastFilter).toEqual({ agentId: AGENT, caseId: CASE });
    expect((await get(`/eval-runs?case=${EVAL}`, dfl(ALICE))).json.runs).toEqual([]);
  });

  it("answers 400 for a filter that is not a uuid", async () => {
    expect(await get("/eval-runs?agent=nope", dfl(ALICE))).toMatchObject({ status: 400, json: { error: "invalid_query" } });
    expect(await get("/eval-runs?case=1", dfl(ALICE))).toMatchObject({ status: 400, json: { error: "invalid_query" } });
  });

  it("answers 401 without a session, an empty list to another principal, and 503 before 0023", async () => {
    expect((await get("/eval-runs")).status).toBe(401);
    expect((await get(`/eval-runs?case=${CASE}`, dfl(BOB))).json).toEqual({ runs: [], limit: EVAL_RUNS_LIMIT, truncated: false });
    reader.isReady = false;
    expect(await get("/eval-runs", dfl(ALICE))).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
  });
});

describe("pure helpers", () => {
  it("graderSummaries counts the latest row of each grader version per run", () => {
    const s = graderSummaries([{ graders: [grade(false, 0, "a"), grade(true, 90, "b")], trajectorySummary: null }, { graders: [], trajectorySummary: null }]);
    expect(s).toEqual([{
      id: "hidden-tests", semver: "2.0.0", kind: "code", codeSha256: H("f"), n: 1, pass: 1, meanScore: 90, hardGate: true, decisive: true,
      proof: { caught: 3, total: 3 }, calibration: null, note: "v2", author: "claude-main",
    }]);
  });

  it("trajectorySummaryOf names the first failed step and counts the error classes", () => {
    expect(trajectorySummaryOf([
      { seq: 2, status: "timeout", error_class: "timeout" },
      { seq: 1, status: "ok", error_class: null },
      { seq: 3, status: "error", error_class: "timeout" },
    ])).toEqual({ steps: 3, firstFailureSeq: 2, errorClasses: { timeout: 2 } });
    expect(trajectorySummaryOf([])).toEqual({ steps: 0, firstFailureSeq: null, errorClasses: {} });
  });
});
