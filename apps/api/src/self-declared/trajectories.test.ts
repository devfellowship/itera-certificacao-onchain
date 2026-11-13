/** GET /trajectories over a fake reader (plan 20261112-tma-c5-studio-area-web2, C5-T9, studio S9). */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathMap, TRAJECTORY_SHAPES_SPEC } from "@itera/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../auth/session.js";
import {
  TRAJECTORIES_SQL,
  createTrajectoriesRouter,
  runView,
  trajectoriesResponse,
  type TrajectoriesFilter,
  type TrajectoriesReader,
  type TrajectoryRunRecord,
} from "./trajectories.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const BOB = "dfl:00000000-0000-4000-8000-00000000000b";
const AGENT = "ab6f3c2e-1d4a-4c8e-9f00-123456789abc";
const dfl = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;

/** A stored run: `kinds` uses the step_kind names; `failAt` marks one step ok = false. */
type FakeRun = TrajectoryRunRecord & { owner: string; public: boolean; taskId: string };
const KIND_OF: Record<string, string> = { R: "read", S: "search", W: "write", T: "test", M: "mcp", X: "shell" };
function rec(id: string, letters: string, over: Partial<FakeRun> = {}, failAt: number | null = null): FakeRun {
  return {
    id, evaluationId: "e1000000-1d4a-4c8e-9f00-123456789abc", agentId: AGENT, status: "pass", resultOrigin: "hosted",
    stepKinds: [...letters].map((l) => KIND_OF[l]!), oks: [...letters].map((_, i) => i !== failAt),
    owner: BOB, public: true, taskId: "t-1", ...over,
  };
}

class FakeReader implements TrajectoriesReader {
  isReady = true;
  calls: Array<{ owner: string; filter: TrajectoriesFilter; limit: number }> = [];
  constructor(public runs: FakeRun[]) {}
  async ready() {
    return this.isReady;
  }
  /** Same scope as the SQL: a public hosted run, or the caller's own run. */
  async list(owner: string, filter: TrajectoriesFilter, limit: number) {
    this.calls.push({ owner, filter, limit });
    return this.runs
      .filter((r) => (r.resultOrigin === "hosted" && r.public) || r.owner === owner)
      .filter((r) => !filter.agentId || r.agentId === filter.agentId)
      .filter((r) => !filter.task || r.taskId === filter.task)
      .filter((r) => !filter.origin || r.resultOrigin === filter.origin)
      .slice(0, limit);
  }
}

const RUNS: FakeRun[] = [
  rec("r-pub", "RRSWT"),
  rec("r-pub-fail", "RSWWT", { status: "fail" }, 4),
  rec("r-bob-private", "RRRR", { public: false }),
  rec("r-bob-upload", "SSW", { resultOrigin: "self_declared", public: false }),
  rec("r-alice-upload", "RW", { resultOrigin: "self_declared", owner: ALICE, public: false, status: "fail" }, 0),
];

let server: Server;
let base = "";
let reader: FakeReader;
async function listen(r: TrajectoriesReader, namedShapes?: boolean) {
  const app = express();
  app.use(createTrajectoriesRouter(r, namedShapes === undefined ? {} : { namedShapes }));
  server = app.listen(0);
  await new Promise<void>((ok) => server.once("listening", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
beforeEach(async () => {
  reader = new FakeReader(RUNS);
  await listen(reader);
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
const get = async (path: string, token?: string) => {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as any, bytes: Buffer.byteLength(text) };
};

describe("GET /trajectories", () => {
  it("answers 401 without a session, and 503 before 0024", async () => {
    expect((await get("/trajectories")).status).toBe(401);
    reader.isReady = false;
    expect(await get("/trajectories", dfl(ALICE))).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
  });

  it("returns the public hosted runs plus the caller's own runs, never another principal's private run", async () => {
    const r = await get("/trajectories", dfl(ALICE));
    expect(r.status).toBe(200);
    expect(r.json.runs.map((x: { id: string }) => x.id)).toEqual(["r-pub", "r-pub-fail", "r-alice-upload"]);
    expect(reader.calls[0]).toEqual({ owner: ALICE, filter: {}, limit: 301 });
    const bob = await get("/trajectories", dfl(BOB));
    expect(bob.json.runs.map((x: { id: string }) => x.id)).toEqual(["r-pub", "r-pub-fail", "r-bob-private", "r-bob-upload"]);
  });

  it("sends the compact row: kind string from the spec, step count, first failure; no shape while named_shapes is false", async () => {
    const r = await get("/trajectories", dfl(ALICE));
    expect(r.json).toMatchObject({ schema: "trajectory-shapes/1", namedShapes: false, fallback: "wall-only", limit: 300, truncated: false });
    expect(r.json.runs[1]).toEqual({
      id: "r-pub-fail", evaluationId: "e1000000-1d4a-4c8e-9f00-123456789abc", agentId: AGENT, status: "fail", resultOrigin: "hosted",
      kinds: "RSWWT", truncated: false, steps: 5, firstFailure: 4,
    });
    expect(r.json.runs[2]).toMatchObject({ resultOrigin: "self_declared", kinds: "RW", firstFailure: 0 });
    expect(r.json.runs[0].firstFailure).toBeNull();
    for (const run of r.json.runs) expect(run).not.toHaveProperty("shape");
  });

  it("adds a shape per run only when the spec flag is on", async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await listen(reader, true);
    const r = await get("/trajectories", dfl(ALICE));
    expect(r.json.namedShapes).toBe(true);
    expect(r.json.runs.map((x: { shape: string }) => x.shape)).toEqual(["straight", "straight", "straight"]);
  });

  it("passes the filters and answers 400 on a bad one; limit is capped at 1000", async () => {
    await get(`/trajectories?agent=${AGENT}&task=webhook-dup&origin=self_declared&limit=50`, dfl(ALICE));
    expect(reader.calls.at(-1)).toEqual({ owner: ALICE, filter: { agentId: AGENT, task: "webhook-dup", origin: "self_declared" }, limit: 51 });
    await get("/trajectories?limit=5000", dfl(ALICE));
    expect(reader.calls.at(-1)!.limit).toBe(1001);
    for (const q of ["agent=nope", "origin=fleet", "limit=0", "limit=abc", "task=a%20b"]) {
      expect(await get(`/trajectories?${q}`, dfl(ALICE)), q).toMatchObject({ status: 400, json: { error: "invalid_query" } });
    }
  });

  it("says truncated when the reader has more rows than the limit", async () => {
    const r = await get("/trajectories?limit=2", dfl(ALICE));
    expect(r.json).toMatchObject({ limit: 2, truncated: true });
    expect(r.json.runs).toHaveLength(2);
  });
});

describe("path map", () => {
  it("keeps the spec's pruned nodes with pass counts, and links each node to its parent", () => {
    // 20 runs: trunk R -> S, then 4 branches W, T, M, X (5 runs each); the W branch passes, the others fail.
    const letters = ["W", "T", "M", "X"];
    const records = letters.flatMap((b) => Array.from({ length: 5 }, (_, i) => rec(`${b}${i}`, `RRS${b}${b}`, { status: b === "W" ? "pass" : "fail" })));
    const res = trajectoriesResponse(records, 300);
    // The same nodes as the contracts implementation (no fork of the prune rule).
    expect(res.pathMap.nodes.map(({ path, n }) => ({ path, n }))).toEqual(pathMap(records.map((r) => runView(r).kinds)).nodes);
    expect(res.pathMap.nodes).toEqual([
      { path: "R", n: 20, pass: 5, passRate: 0.25 },
      { path: "RS", n: 20, pass: 5, passRate: 0.25 },
      { path: "RSM", n: 5, pass: 0, passRate: 0 },
      { path: "RST", n: 5, pass: 0, passRate: 0 },
      { path: "RSW", n: 5, pass: 5, passRate: 1 },
      { path: "RSX", n: 5, pass: 0, passRate: 0 },
    ]);
    expect(res.pathMap.edges).toEqual([
      { from: "R", to: "RS" },
      { from: "RS", to: "RSM" },
      { from: "RS", to: "RST" },
      { from: "RS", to: "RSW" },
      { from: "RS", to: "RSX" },
    ]);
    expect(res.pathMap.totalRuns).toBe(20);
  });

  it("maps a null step_kind to X (other) and a null ok to not failed", () => {
    const v = runView({ id: "x", evaluationId: null, agentId: null, status: "fail", resultOrigin: "self_declared", stepKinds: [null, "read"], oks: [null, false] });
    expect(v).toMatchObject({ kinds: "XR", firstFailure: 1, steps: 2 });
  });

  it("finds the first failure past the kind string cut", () => {
    const n = TRAJECTORY_SHAPES_SPEC.kind_string.max_chars + 10;
    const v = runView(rec("long", "R".repeat(n), {}, n - 1));
    expect(v).toMatchObject({ truncated: true, steps: n, firstFailure: n - 1 });
    expect(v.kinds).toHaveLength(TRAJECTORY_SHAPES_SPEC.kind_string.max_chars);
  });
});

describe("size budget", () => {
  it("300 runs x 40 steps serialize under 300 KB", async () => {
    const alphabet = "RSWTMX";
    const many = Array.from({ length: 300 }, (_, i) => {
      const letters = Array.from({ length: 40 }, (_, j) => alphabet[(i * 7 + j * (1 + (i % 5))) % 6]).join("");
      return rec(`${i.toString(16).padStart(8, "0")}-1d4a-4c8e-9f00-123456789abc`, letters, { status: i % 3 ? "pass" : "fail" }, i % 3 ? null : 20);
    });
    reader.runs = many;
    const r = await get("/trajectories", dfl(ALICE));
    expect(r.json.runs).toHaveLength(300);
    expect(r.json.runs[0].kinds).toHaveLength(40);
    expect(r.bytes).toBeLessThan(300 * 1024);
  });
});

describe("SQL shape", () => {
  it("is one statement: the runs are picked and limited first, then the steps are read by run_id in seq order", () => {
    expect(TRAJECTORIES_SQL.split(";").filter((s) => s.trim()).length).toBe(1);
    expect(TRAJECTORIES_SQL).toMatch(/with picked as \([\s\S]*limit \$6\s*\)/);
    expect(TRAJECTORIES_SQL).toMatch(/from public\.run_actions a\s+where a\.run_id = p\.id/);
    expect(TRAJECTORIES_SQL).toMatch(/array_agg\(a\.step_kind order by a\.seq\)/);
    // The scope: a hosted run of an issued public evaluation, or the caller's own run.
    expect(TRAJECTORIES_SQL).toMatch(/\(r\.result_origin = 'hosted' and e\.status = 'issued' and e\.is_public\) or r\.owner_wallet = \$1/);
  });
});
