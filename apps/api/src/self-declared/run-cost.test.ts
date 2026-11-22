/**
 * POST /eval-results/run-cost (plan 20261112-tma-c7-model-comparison-per-use-case, C7-COST): the matching rule and the
 * router on a fake store. The SQL is proved on Postgres in run-cost.pg.test.ts.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunCostBody } from "@itera/contracts";
import { issueSessionToken } from "../auth/session.js";
import { createRunCostRouter, planRunCost, type RunCostOutcome, type RunCostStore, type StoredCostRun } from "./run-cost.js";
import { SelfDeclaredError } from "./store.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "dfl:00000000-0000-4000-8000-00000000000a";
const dfl = (who: string) => issueSessionToken(who, Date.now(), "dfl").token;
const siws = issueSessionToken("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", Date.now(), "siws").token;

const PRICE = { model_id: "zai/glm-5.3", input: 2, cache_read: 0.1, cache_write: 2.5, output: 10, source_url: "https://example.test/pricing", as_of: "2026-11-21", table_sha256: "a".repeat(64) };
const RUN = { tokens_in: 1_000_000, tokens_out: 50_000, cache_read_tokens: 600_000, cache_write_tokens: 100_000 };
const BODY = (over: Record<string, unknown> = {}) => ({ format: "tma-run-cost/1", evaluation_id: "88c18100-374d-8310-9155-e78917352bbb", price: PRICE, runs: [RUN], ...over });
const row = (id: string, over: Partial<StoredCostRun> = {}): StoredCostRun => ({ id, tokensIn: 1_000_000, tokensOut: 50_000, costUsd: null, costSource: null, model: "zai/glm-5.3", ...over });
const asBody = (over: Record<string, unknown> = {}) => BODY(over) as unknown as RunCostBody;

describe("planRunCost", () => {
  it("matches an entry to the run with the same tokens and prices it with derivedCostUsd (1.41)", () => {
    expect(planRunCost([row("r1")], asBody())).toEqual([{ runId: "r1", costUsd: 1.41, op: "update" }]);
  });
  it("two entries with the same tokens fill two runs, and a third entry is run_not_found", () => {
    const two = planRunCost([row("r1"), row("r2")], asBody({ runs: [RUN, RUN] }));
    expect(two.map((p) => p.runId).sort()).toEqual(["r1", "r2"]);
    expect(() => planRunCost([row("r1"), row("r2")], asBody({ runs: [RUN, RUN, RUN] }))).toThrow(/runs\[2\] matches no run/);
  });
  it("a run with other tokens or another model is not matched", () => {
    expect(() => planRunCost([row("r1", { tokensOut: 49_999 })], asBody())).toThrow(SelfDeclaredError);
    expect(() => planRunCost([row("r1", { model: "codex/gpt-5.6-sol" })], asBody())).toThrow(/run_not_found|matches no run/);
  });
  it("the same derived cost is unchanged; another cost is cost_exists and is never overwritten", () => {
    expect(planRunCost([row("r1", { costUsd: 1.41, costSource: "derived" })], asBody())).toEqual([{ runId: "r1", costUsd: 1.41, op: "same" }]);
    expect(() => planRunCost([row("r1", { costUsd: 0.5, costSource: "metered" })], asBody())).toThrow(/never overwritten/);
    expect(() => planRunCost([row("r1", { costUsd: 0.5, costSource: "derived" })], asBody())).toThrow(/never overwritten/);
  });
  it("an estimate body plans an update; the same estimate cost is same", () => {
    expect(planRunCost([row("r1")], asBody({ cost_source: "estimate" }))).toEqual([{ runId: "r1", costUsd: 1.41, op: "update" }]);
    expect(planRunCost([row("r1", { costUsd: 1.41, costSource: "estimate" })], asBody({ cost_source: "estimate" }))).toEqual([{ runId: "r1", costUsd: 1.41, op: "same" }]);
  });
  it("an estimate never replaces a derived cost, and a derived never replaces an estimate (409 cost_exists)", () => {
    for (const [stored, source] of [["derived", "estimate"], ["estimate", "derived"]] as const) {
      try {
        planRunCost([row("r1", { costUsd: 1.41, costSource: stored })], asBody({ cost_source: source }));
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(SelfDeclaredError);
        expect((e as SelfDeclaredError).status).toBe(409);
        expect((e as SelfDeclaredError).code).toBe("cost_exists");
      }
    }
  });
});

class FakeStore implements RunCostStore {
  calls: Array<{ owner: string; dryRun: boolean; body: RunCostBody }> = [];
  failWith: Error | null = null;
  async applyRunCost(owner: string, body: RunCostBody, o: { dryRun: boolean }): Promise<RunCostOutcome> {
    this.calls.push({ owner, dryRun: o.dryRun, body });
    if (this.failWith) throw this.failWith;
    return { evaluationId: body.evaluation_id, matched: 1, updated: 1, unchanged: 0, runs: [{ runId: "r1", costUsd: 1.41 }] };
  }
}

let server: Server;
let base = "";
let store: FakeStore;
let ready = true;

beforeEach(async () => {
  store = new FakeStore();
  ready = true;
  const app = express();
  app.use(express.json());
  app.use(createRunCostRouter({ store, ready: async () => ready }));
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const post = async (body: unknown, token?: string) => {
  const res = await fetch(`${base}/eval-results/run-cost`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
};

describe("POST /eval-results/run-cost", () => {
  it("needs a session, and a dfl one", async () => {
    expect((await post(BODY())).status).toBe(401);
    expect(await post(BODY(), siws)).toMatchObject({ status: 403, json: { error: "self_declared_dfl_only" } });
    expect(store.calls).toEqual([]);
  });

  it("is a dry run by default; only the boolean false writes", async () => {
    const dry = await post(BODY(), dfl(ALICE));
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ format: "tma-run-cost/1", dry_run: true, matched: 1, updated: 0, runs: [{ run_id: "r1", cost_usd: 1.41 }] });
    const real = await post(BODY({ dry_run: false }), dfl(ALICE));
    expect(real.json).toMatchObject({ dry_run: false, updated: 1 });
    expect(store.calls.map((c) => [c.owner, c.dryRun])).toEqual([[ALICE, true], [ALICE, false]]);
  });

  it("refuses an unknown key (a body cannot carry a cost, a grade or a patch) with 400 and calls nothing", async () => {
    for (const extra of [{ cost_usd: 9 }, { score: 100 }, { patch: "x" }]) {
      const r = await post(BODY(extra), dfl(ALICE));
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("unknown_key");
    }
    const run = await post(BODY({ runs: [{ ...RUN, cost_usd: 1 }] }), dfl(ALICE));
    expect(run.json).toMatchObject({ error: "unknown_key", path: "/runs/0/cost_usd" });
    expect(store.calls).toEqual([]);
  });

  it("passes the store's refusals through (404 evaluation_not_found, 409 run_not_found / cost_exists)", async () => {
    for (const [status, code] of [[404, "evaluation_not_found"], [409, "run_not_found"], [409, "cost_exists"]] as const) {
      store.failWith = new SelfDeclaredError(status, code, "x");
      expect(await post(BODY(), dfl(ALICE))).toMatchObject({ status, json: { error: code } });
    }
  });

  it("answers 503 schema_not_ready before 0023", async () => {
    ready = false;
    expect(await post(BODY({ dry_run: false }), dfl(ALICE))).toMatchObject({ status: 503, json: { error: "schema_not_ready" } });
    expect(store.calls).toEqual([]);
  });
});
