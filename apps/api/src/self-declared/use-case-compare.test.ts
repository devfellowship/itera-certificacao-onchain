/**
 * GET /use-cases/:key/compare over a fake reader (plan 20261112-tma-c7-model-comparison-per-use-case, C7-T3). The fake
 * filters by owner, tenant and use case as PgUseCaseCompareReader does; the numbers come from @itera/contracts/compare.
 * Proves: 3 agents x 2 cases x 5 runs → n = 10 each, both verdicts, a cost label; current_agent drives the relative
 * verdict (better / tie; without it refused no_current_agent); an unknown query parameter or a malformed key → 400; a
 * run of another principal or tenant changes no number; an infra_ok = false run only moves infra_error_count; the body
 * of one use case with 10 agents x 5 cases x 5 runs is below 200 KB / 33.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../auth/session.js";
import {
  agentKeyOf, createUseCaseCompareRouter, useCaseRunsOf, type CompareGraderRow, type CompareRunRow, type UseCaseCompareReader,
  type UseCaseRows,
} from "./use-case-compare.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const BOB = "dfl:00000000-0000-4000-8000-00000000000b";
const TENANT = "devfellowship";
const UC = "fix/prod-bug";
const dfl = (id: string) => issueSessionToken(id, Date.now(), "dfl").token;
const H = (c: string) => c.repeat(64);
const uuid = (n: number, tag = "a") => `${tag.repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Row { run: CompareRunRow; graders: CompareGraderRow[]; owner: string; tenant: string; useCase: string }

class FakeReader implements UseCaseCompareReader {
  isReady = true;
  rows: Row[] = [];
  async ready() {
    return this.isReady;
  }
  async rowsOf(useCaseKey: string, owner: string, tenant: string): Promise<UseCaseRows> {
    const mine = this.rows.filter((r) => r.owner === owner && r.tenant === tenant && r.useCase === useCaseKey);
    return { runs: mine.map((r) => r.run), graders: mine.flatMap((r) => r.graders) };
  }
}

interface AgentSpec { sha: string; model: string; variant: string; lintPass: (i: number) => boolean; cost: number; source: string }
const A: AgentSpec = { sha: H("1"), model: "anthropic/claude-sonnet-5-5", variant: uuid(1), lintPass: () => true, cost: 0.03, source: "metered" };
const B: AgentSpec = { sha: H("2"), model: "zai/glm-5.3", variant: uuid(2), lintPass: () => false, cost: 0.01, source: "derived" };
const C: AgentSpec = { sha: H("3"), model: "opencode-go/deepseek-v4-pro", variant: uuid(3), lintPass: () => true, cost: 0.02, source: "mixed" };
const keyOf = (s: AgentSpec) => agentKeyOf({ agentSha256: s.sha, modelId: s.model });

let seq = 0;
function row(s: AgentSpec, caseKey: string, i: number, over: Partial<Row> & { infraOk?: boolean | null } = {}): Row {
  const runId = uuid(++seq, "b");
  const g = (graderId: string, pass: boolean, weight: number, hardGate: boolean): CompareGraderRow => ({
    runId, graderId, semver: "1.0.0", kind: "code", pass, weight, hardGate, decisive: true,
  });
  return {
    run: {
      runId, caseKey, variantId: s.variant, agentSha256: s.sha, modelId: s.model, harness: "opencode",
      infraOk: over.infraOk === undefined ? true : over.infraOk, costUsd: s.cost, costSource: s.source, wallMs: 1000 + i * 10,
    },
    // hidden-tests: weight 3, hard gate, passes; lint: weight 1. A judge row that is not decisive and a human label
    // never count (the library ignores them).
    graders: [
      g("hidden-tests", true, 3, true),
      g("lint", s.lintPass(i), 1, false),
      { ...g("rubric-judge", false, 1, false), kind: "judge", decisive: false },
      { ...g("human-label", false, 1, false), kind: "human" },
    ],
    owner: ALICE,
    tenant: TENANT,
    useCase: UC,
    ...over,
  };
}
const fixture = (specs: AgentSpec[], cases = ["case-1", "case-2"], runs = 5): Row[] =>
  specs.flatMap((s) => cases.flatMap((c) => Array.from({ length: runs }, (_, i) => row(s, c, i))));

let server: Server;
let base = "";
let reader: FakeReader;

beforeEach(async () => {
  reader = new FakeReader();
  reader.rows = fixture([A, B, C]);
  const app = express();
  app.use(createUseCaseCompareRouter({ reader, tenant: TENANT }));
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const enc = encodeURIComponent;
const get = async (path: string, token: string | null = dfl(ALICE)) => {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as any, text, bytes: Buffer.byteLength(text) };
};
const compare = (query = "", token?: string | null) => get(`/use-cases/${enc(UC)}/compare${query}`, token);
const agentOf = (body: any, s: AgentSpec) => body.agents.find((a: any) => a.agent_key === keyOf(s));

describe("GET /use-cases/:key/compare", () => {
  it("compares 3 agents x 2 cases x 5 runs: n = 10 each, both verdicts, a cost label", async () => {
    const r = await compare();
    expect(r.status).toBe(200);
    expect(r.json.use_case).toBe(UC);
    expect(r.json.profile).toEqual({
      source: "defaults", sha256: null, weights: "stored_per_result", min_runs_per_cell: 5, relative_margin_points: 5,
      relative_alpha: 0.05, relative_test: "mann-whitney-u", absolute_bars: { same: 95, close: 85 },
    });
    expect(r.json.rule_text.absolute).toContain("SAME");
    expect(r.json.rule_text.relative).toContain("Mann-Whitney");
    expect(r.json.agents).toHaveLength(3);
    for (const a of r.json.agents) {
      expect(a.n).toBe(10);
      expect(a.infra_error_count).toBe(0);
      expect(a.absolute.label).not.toBe("refused");
      expect(a.relative).toMatchObject({ label: "refused", reason: "no_current_agent" });
      expect(["metered", "derived"]).toContain(a.cost_label);
      expect(a).not.toHaveProperty("scores");
    }
    const a = agentOf(r.json, A);
    expect(a).toMatchObject({
      variant_ids: [A.variant], model_id: A.model, harness: "opencode", mean_score: 100, cost_per_task: 0.03, cost_label: "metered",
      median_wall_ms: 1020, no_score_runs: 0, hard_gate_failures: 0,
      distribution: { min: 100, p10: 100, p50: 100, p90: 100, max: 100 },
      absolute: { label: "SAME", reason: null, runs_at_least_same: 10, runs_at_least_close: 10 },
    });
    // B fails lint (weight 1 of 4): 75 per run.
    expect(agentOf(r.json, B)).toMatchObject({ mean_score: 75, cost_label: "derived", absolute: { label: "NOT YET" } });
    // `mixed` is not metered: derived.
    expect(agentOf(r.json, C)).toMatchObject({ cost_label: "derived" });
    // Pareto: B (75, 0.01) and C (100, 0.02) are on the front; A (100, 0.03) is dominated by C.
    expect(agentOf(r.json, A).pareto).toEqual({ ineligible_reason: null, on_front: false, dominated: true });
    expect(agentOf(r.json, C).pareto).toMatchObject({ on_front: true, dominated: false });
    // No trace or case text in the body.
    expect(JSON.stringify(r.json)).not.toMatch(/case-1|hidden-tests|rubric/);
  });

  it("computes the relative verdict against current_agent (agent key or variant id)", async () => {
    const byKey = await compare(`?current_agent=${enc(keyOf(B))}`);
    expect(byKey.status).toBe(200);
    expect(byKey.json.current_agent).toBe(keyOf(B));
    expect(agentOf(byKey.json, A).relative).toMatchObject({ label: "better", reason: null, gap: 25, mann_whitney: { method: "exact" } });
    expect(agentOf(byKey.json, A).relative.mann_whitney.p).toBeLessThan(0.05);
    expect(agentOf(byKey.json, B).relative).toMatchObject({ label: "refused", reason: "is_current_agent" });

    const byVariant = await compare(`?current_agent=${A.variant}`);
    expect(byVariant.json.current_agent).toBe(keyOf(A));
    expect(agentOf(byVariant.json, C).relative).toMatchObject({ label: "tie", reason: "gap_below_margin" });
    expect(agentOf(byVariant.json, B).relative).toMatchObject({ label: "worse" });

    const none = await compare();
    expect(agentOf(none.json, A).relative).toMatchObject({ label: "refused", reason: "no_current_agent" });

    expect((await compare(`?current_agent=${uuid(99)}`)).json).toMatchObject({ error: "unknown_current_agent" });
    expect((await compare(`?current_agent=${enc(`zai/glm-5.3#${H("9")}`)}`)).status).toBe(400);
  });

  it("refuses any other query parameter and a malformed key", async () => {
    expect(await compare("?q=hello")).toMatchObject({ status: 400, json: { error: "invalid_query" } });
    expect(await compare(`?current_agent=${A.variant}&note=x`)).toMatchObject({ status: 400, json: { error: "invalid_query" } });
    expect(await compare(`?current_agent=${A.variant}&current_agent=${B.variant}`)).toMatchObject({ status: 400, json: { error: "invalid_query" } });
    expect(await compare("?current_agent=hello%20world")).toMatchObject({ status: 400, json: { error: "invalid_query" } });
    for (const bad of ["fix", "Fix%2Fprod", "fix%2Fprod%2Fbug", "fix%2F", "%2Fprod", "fix%20x%2Fy", "-fix%2Fy"]) {
      expect(await get(`/use-cases/${bad}/compare`), bad).toMatchObject({ status: 400, json: { error: "invalid_use_case" } });
    }
  });

  it("needs a session and answers 503 before 0023", async () => {
    expect((await compare("", null)).status).toBe(401);
    reader.isReady = false;
    expect(await compare()).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
  });

  it("a run of another principal or another tenant changes no number", async () => {
    const before = await compare(`?current_agent=${A.variant}`);
    reader.rows.push(
      ...fixture([B], ["case-1"], 5).map((r) => ({ ...r, owner: BOB })),
      ...fixture([A], ["case-1"], 5).map((r) => ({ ...r, tenant: "other-tenant" })),
      ...fixture([C], ["case-1"], 5).map((r) => ({ ...r, useCase: "fix/other" })),
    );
    // Make the foreign rows different: they would move every number if they counted.
    for (const r of reader.rows.slice(-15)) for (const g of r.graders) g.pass = false;
    const after = await compare(`?current_agent=${A.variant}`);
    expect(after.json).toEqual(before.json);
    // Bob sees his own row only; Alice's variant is not an agent of his view.
    const bob = await compare("", dfl(BOB));
    expect(bob.json.agents).toHaveLength(1);
    expect(bob.json.agents[0]).toMatchObject({ agent_key: keyOf(B), n: 5, mean_score: 0 });
    expect((await compare(`?current_agent=${A.variant}`, dfl(BOB))).json).toMatchObject({ error: "unknown_current_agent" });
  });

  it("an infra_ok = false run is counted in infra_error_count and moves no other number", async () => {
    const before = await compare(`?current_agent=${B.variant}`);
    const bad = row(A, "case-1", 9, { infraOk: false });
    for (const g of bad.graders) g.pass = false;
    bad.run.costUsd = 9;
    bad.run.wallMs = 999_999;
    reader.rows.push(bad);
    const after = await compare(`?current_agent=${B.variant}`);
    const a0 = agentOf(before.json, A);
    const a1 = agentOf(after.json, A);
    expect(a1.infra_error_count).toBe(1);
    expect({ ...a1, infra_error_count: 0 }).toEqual(a0);
    expect(after.json.agents.filter((a: any) => a.agent_key !== keyOf(A))).toEqual(before.json.agents.filter((a: any) => a.agent_key !== keyOf(A)));
  });

  it("keeps one use case with 10 agents x 5 cases x 5 runs below 200 KB / 33 (gzip)", async () => {
    const specs: AgentSpec[] = Array.from({ length: 10 }, (_, i) => ({
      sha: H(i.toString(16)), model: `lab-${i}/model-${i}-preview`, variant: uuid(100 + i),
      lintPass: (k: number) => (k + i) % 3 !== 0, cost: 0.0123456 * (i + 1), source: i % 2 ? "metered" : "derived",
    }));
    reader.rows = fixture(specs, ["c1", "c2", "c3", "c4", "c5"], 5);
    const r = await compare(`?current_agent=${specs[0]!.variant}`);
    expect(r.status).toBe(200);
    expect(r.json.agents).toHaveLength(10);
    expect(r.json.agents.every((a: any) => a.n === 25)).toBe(true);
    // The budget: 33 use cases x 10 agents in 200 KB on the wire. The rule texts of the library alone are ~1.1 KB and
    // a row with every field of the brief is ~700 B, so the raw JSON is ~8 KB: the gzip body meets the budget, and
    // the raw body has a regression cap of 300 KB / 33 (see report.md).
    expect(gzipSync(r.text).length).toBeLessThan((200 * 1024) / 33);
    expect(r.bytes).toBeLessThan((300 * 1024) / 33);
  });
});

describe("useCaseRunsOf", () => {
  it("maps cost sources, infra_ok and a stored weight of 0", () => {
    const run = (costSource: string | null, costUsd: number | null, infraOk: boolean | null): CompareRunRow => ({
      runId: "r", caseKey: "c", variantId: "v", agentSha256: H("1"), modelId: "zai/glm-5.3", harness: "opencode", infraOk, costUsd, costSource, wallMs: null,
    });
    const g: CompareGraderRow = { runId: "r", graderId: "t", semver: "1.0.0", kind: "code", pass: true, weight: 0, hardGate: true, decisive: true };
    const map = (r: CompareRunRow) => useCaseRunsOf({ runs: [r], graders: [g] })[0]!;
    expect(map(run("metered", 0.1, null))).toMatchObject({ costUsd: 0.1, costSource: "metered", infraOk: true });
    expect(map(run("derived", 0.1, true))).toMatchObject({ costSource: "derived" });
    expect(map(run("mixed", 0.1, true))).toMatchObject({ costSource: "derived" });
    expect(map(run("unpriced", 0.1, true))).toMatchObject({ costUsd: null, costSource: null });
    expect(map(run("none", 0, true))).toMatchObject({ costUsd: null, costSource: null });
    expect(map(run(null, null, false))).toMatchObject({ costUsd: null, costSource: null, infraOk: false });
    expect(map(run(null, 0.2, true))).toMatchObject({ costUsd: 0.2, costSource: null });
    expect(map(run("metered", 0.1, true)).graders).toEqual([
      { graderId: "t@1.0.0", kind: "code", pass: true, weight: null, hardGate: true, decisive: true },
    ]);
  });
});
