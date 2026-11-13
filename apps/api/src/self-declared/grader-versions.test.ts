/** The grader library read routes over a fake reader (plan 20261112-tma-c5-studio-area-web2, C5-T5). */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../auth/session.js";
import { createGraderVersionsRouter, type GraderVersionDetail, type GraderVersionsReader } from "./grader-versions.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const GV1 = "1b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const GV_OTHER = "2b6f3c2e-1d4a-4c8e-9f00-123456789abc";
const dfl = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;

const detail: GraderVersionDetail = {
  id: GV1, graderId: "hidden-tests", semver: "2.0.0", kind: "judge", codeSha256: "f".repeat(64), judgeModelId: "openrouter/zai/glm-5.3",
  createdAt: "2026-11-12T12:00:00.000Z", usedByCount: 4, rubricSha256: "a".repeat(64), paramsSha256: null, testSplitSha256: null,
  tpr: 0.9, tnr: 0.8, proof: { caught: 3, total: 3 }, note: "v2", author: "claude-main",
  calibration: { nLabels: 30, nTest: 10, tp: 4, fn: 1, tn: 4, fp: 1, realignedAt: null },
  recentRuns: [{ runId: "3b6f3c2e-1d4a-4c8e-9f00-123456789abc", caseId: null, evaluationId: null, pass: true, gradedAt: "2026-11-12T12:05:00.000Z" }],
};

class FakeReader implements GraderVersionsReader {
  isReady = true;
  tenants: string[] = [];
  async ready() {
    return this.isReady;
  }
  async list(tenant: string) {
    this.tenants.push(tenant);
    const { recentRuns: _r, rubricSha256: _a, paramsSha256: _b, testSplitSha256: _c, tpr: _d, tnr: _e, proof: _f, note: _g, author: _h, calibration: _i, ...item } = detail;
    return tenant === "devfellowship" ? [item] : [];
  }
  async detail(id: string, tenant: string) {
    return id === GV1 && tenant === "devfellowship" ? detail : null;
  }
}

let server: Server;
let base = "";
let reader: FakeReader;
beforeEach(async () => {
  reader = new FakeReader();
  const app = express();
  app.use(createGraderVersionsRouter(reader, { tenant: "devfellowship" }));
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

describe("GET /grader-versions", () => {
  it("lists the versions of the tenant with usedByCount", async () => {
    const r = await get("/grader-versions", dfl(ALICE));
    expect(r.status).toBe(200);
    expect(r.json.graderVersions).toEqual([
      { id: GV1, graderId: "hidden-tests", semver: "2.0.0", kind: "judge", codeSha256: "f".repeat(64), judgeModelId: "openrouter/zai/glm-5.3", createdAt: "2026-11-12T12:00:00.000Z", usedByCount: 4 },
    ]);
  });
  it("answers 401 without a session, and 503 before 0023", async () => {
    expect((await get("/grader-versions")).status).toBe(401);
    reader.isReady = false;
    expect(await get("/grader-versions", dfl(ALICE))).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
  });
});

describe("GET /grader-versions/:id", () => {
  it("returns the detail with judge, calibration, proof and recent runs", async () => {
    const r = await get(`/grader-versions/${GV1}`, dfl(ALICE));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: GV1, tpr: 0.9, tnr: 0.8, proof: { caught: 3, total: 3 }, calibration: { nLabels: 30 }, recentRuns: [{ pass: true }] });
  });
  it("answers 401, 404 for another tenant's id and a non uuid, and 503", async () => {
    expect((await get(`/grader-versions/${GV1}`)).status).toBe(401);
    expect(await get(`/grader-versions/${GV_OTHER}`, dfl(ALICE))).toEqual({ status: 404, json: { error: "grader version not found" } });
    expect((await get("/grader-versions/nope", dfl(ALICE))).status).toBe(404);
    reader.isReady = false;
    expect((await get(`/grader-versions/${GV1}`, dfl(ALICE))).status).toBe(503);
  });
  it("scopes by the router tenant", async () => {
    const app = express();
    app.use(createGraderVersionsRouter(reader, { tenant: "other-tenant" }));
    const s = app.listen(0);
    await new Promise<void>((r) => s.once("listening", r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/grader-versions/${GV1}`, { headers: { authorization: `Bearer ${dfl(ALICE)}` } });
    expect(res.status).toBe(404);
    await new Promise<void>((r) => s.close(() => r()));
  });
});
