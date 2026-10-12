import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { computeRanking, FakeRankingStore, initialsOf, type RankAgent, type RankResult } from "../domain/agent-ranking.js";
import { FakeGithubAgentsRepository } from "../domain/github-agents-repository.fake.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { lamportsToSol, usdToLamports } from "../domain/sol-price.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { GitHubConfigError } from "../github/app-client.js";
import { issueSessionToken, requireWallet } from "./auth.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ME = "So11111111111111111111111111111111111111112";
const OTHER = "11111111111111111111111111111111";
const THIRD = "Vote111111111111111111111111111111111111111";

function agent(id: string, ownerWallet: string, extra: Partial<RankAgent> = {}): RankAgent {
  return {
    id,
    slug: id,
    name: id,
    ownerWallet,
    authorName: null,
    description: null,
    model: "qwen/qwen3-coder",
    modelLabel: null,
    visibility: "listed",
    status: null,
    listedAt: null,
    createdAt: "2026-10-12T00:00:00Z",
    ...extra,
  };
}

let seq = 0;
function result(agentId: string, task: string, score: number, extra: Partial<RankResult> = {}): RankResult {
  return {
    agentId,
    runId: `run-${++seq}`,
    runOwnerWallet: OTHER,
    score,
    at: `2026-10-12T0${seq % 10}:00:00Z`,
    issued: true,
    taskKeys: [`uuid-${task}`, task, `pack:${task}@1`],
    taskKind: "itera",
    taskOwnerWallet: null,
    ...extra,
  };
}

describe("computeRanking", () => {
  const base = { callerWallet: ME, scope: "all" as const, q: "", priceUsdPerRun: 0.1, solUsdRate: 100 };

  it("no selection: sorts by score desc, unscored rows last without a rank", () => {
    const out = computeRanking({
      ...base,
      taskIds: [],
      data: {
        agents: [agent("low", OTHER), agent("high", OTHER), agent("mine-unrun", ME)],
        results: [result("low", "a", 50), result("high", "a", 70), result("high", "b", 90)],
        evaluations: [],
      },
    });
    expect(out.rows.map((r) => [r.id, r.rank, r.score, r.taskCount])).toEqual([
      ["high", 1, 80, 2],
      ["low", 2, 50, 1],
      ["mine-unrun", null, null, 0],
    ]);
    expect(out.rows[0]!.coverage).toBeNull();
    expect(out.rows[0]!.runCostUsd).toBeNull();
  });

  it("no selection: the latest issued evaluation score wins over the per-task mean", () => {
    const out = computeRanking({
      ...base,
      taskIds: [],
      data: {
        agents: [agent("x", OTHER)],
        results: [result("x", "a", 10)],
        evaluations: [
          { agentId: "x", score: 60, issuedAt: "2026-10-11T00:00:00Z" },
          { agentId: "x", score: 77.25, issuedAt: "2026-10-12T00:00:00Z" },
        ],
      },
    });
    expect(out.rows[0]!.score).toBe(77.3);
  });

  it("selection: sorts by coverage then score; k = 0 rows carry runCostUsd = n × 0.10 and a SOL cost", () => {
    const out = computeRanking({
      ...base,
      taskIds: ["a", "uuid-b"], // a slug and a uuid both match
      data: {
        agents: [agent("one-high", OTHER), agent("two-low", OTHER), agent("none", OTHER), agent("mine", ME)],
        results: [
          result("one-high", "a", 100),
          result("two-low", "a", 40),
          result("two-low", "b", 60),
          result("two-low", "b", 20), // best per task is kept
          result("none", "zzz", 99),
        ],
        evaluations: [],
      },
    });
    expect(out.rows.map((r) => [r.id, r.rank, r.coverage, r.score, r.runCostUsd])).toEqual([
      ["two-low", 1, { k: 2, n: 2, perTask: [true, true] }, 50, 0],
      ["one-high", 2, { k: 1, n: 2, perTask: [true, false] }, 100, 0.1],
      ["mine", null, { k: 0, n: 2, perTask: [false, false] }, null, 0.2],
      ["none", null, { k: 0, n: 2, perTask: [false, false] }, null, 0.2],
    ]);
    const none = out.rows.find((r) => r.id === "none")!;
    expect(none.runCostLamports).toBe(2_000_000); // US$0.20 at US$100/SOL
    expect(none.runCostSol).toBe("0.002");
  });

  it("other wallets' agents need a listed visibility and an issued result; own agents always appear", () => {
    const out = computeRanking({
      ...base,
      taskIds: [],
      data: {
        agents: [
          agent("listed-issued", OTHER),
          agent("listed-unissued", OTHER),
          agent("private-issued", OTHER, { visibility: "private" }),
          agent("mine-draft", ME),
        ],
        results: [
          result("listed-issued", "a", 80),
          result("listed-unissued", "a", 99, { issued: false }),
          result("private-issued", "a", 99),
          result("mine-draft", "a", 30, { issued: false, runOwnerWallet: ME }),
        ],
        evaluations: [],
      },
    });
    expect(out.rows.map((r) => r.id)).toEqual(["listed-issued", "mine-draft"]);
    expect(out.counts).toEqual({ all: 2, mine: 1 });
    const mine = out.rows.find((r) => r.id === "mine-draft")!;
    expect(mine).toMatchObject({ isMine: true, draft: true, score: 30 }); // own unpublished run is visible to its owner
    expect(out.rows[0]).toMatchObject({ draft: false, isMine: false });
  });

  it("hides results on another wallet's user task and unissued runs of other wallets", () => {
    const out = computeRanking({
      ...base,
      taskIds: ["secret"],
      data: {
        agents: [agent("x", OTHER)],
        results: [
          result("x", "pub", 70),
          result("x", "secret", 100, { taskKind: "user", taskOwnerWallet: THIRD }),
          result("x", "secret", 90, { issued: false }),
        ],
        evaluations: [],
      },
    });
    expect(out.rows[0]!.coverage).toEqual({ k: 0, n: 1, perTask: [false] });
  });

  it("scope=mine and q filter (name, author, description, model label)", () => {
    const data = {
      agents: [
        agent("ledgerline", OTHER, { authorName: "Mara Okafor", description: "Fixes webhooks" }),
        agent("querytune", ME, { model: "anthropic/claude-sonnet-4.6" }),
      ],
      results: [result("ledgerline", "a", 90)],
      evaluations: [],
    };
    expect(computeRanking({ ...base, data, taskIds: [], scope: "mine" }).rows.map((r) => r.id)).toEqual(["querytune"]);
    expect(computeRanking({ ...base, data, taskIds: [], q: "mara" }).rows.map((r) => r.id)).toEqual(["ledgerline"]);
    expect(computeRanking({ ...base, data, taskIds: [], q: "WEBHOOK" }).rows.map((r) => r.id)).toEqual(["ledgerline"]);
    expect(computeRanking({ ...base, data, taskIds: [], q: "sonnet 4.6" }).rows.map((r) => r.id)).toEqual(["querytune"]);
    const row = computeRanking({ ...base, data, taskIds: [] }).rows.find((r) => r.id === "querytune")!;
    expect(row).toMatchObject({ modelLabel: "Claude Sonnet 4.6", authorName: "So11…1112", initials: "QU" });
  });

  it("no rate: USD cost only", () => {
    const out = computeRanking({ ...base, solUsdRate: null, taskIds: ["a"], data: { agents: [agent("x", ME)], results: [], evaluations: [] } });
    expect(out.rows[0]).toMatchObject({ runCostUsd: 0.1, runCostLamports: null, runCostSol: null });
  });

  it("helpers", () => {
    expect(initialsOf("ledger line")).toBe("LE");
    expect(initialsOf("--")).toBe("??");
    expect(usdToLamports(0.1, 108.98)).toBe(917_600);
    expect(lamportsToSol(917_599)).toBe("0.000917599");
    expect(lamportsToSol(1_000_000_000)).toBe("1.0");
  });
});

describe("GET /agents/ranking", () => {
  let server: Server;
  let baseUrl: string;
  let store: FakeRankingStore;
  let rate: number | null;

  beforeEach(async () => {
    store = new FakeRankingStore();
    rate = 100;
    store.data = {
      agents: [agent("ledgerline", OTHER, { name: "Ledgerline" }), agent("mine", ME, { name: "Mine" })],
      results: [result("ledgerline", "a", 91.2)],
      evaluations: [],
    };
    store.tags.set("stripe", ["uuid-a", "uuid-b"]);
    server = createApp(new FakeRepository(), {
      github: {
        repo: new FakeGithubAgentsRepository(),
        github: () => {
          throw new GitHubConfigError("not configured");
        },
        requireWallet,
        stateSecret: () => "test-session-secret",
      },
      ranking: {
        store,
        price: { solUsd: async () => (rate === null ? null : { rate, source: "test", at: "2026-10-12T00:00:00Z" }) },
        priceUsdPerRun: () => 0.1,
        requireWallet,
      },
    }).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function get(path: string, wallet: string | null = ME) {
    const res = await fetch(`${baseUrl}${path}`, { headers: wallet ? { Authorization: `Bearer ${issueSessionToken(wallet).token}` } : {} });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  it("needs a wallet and is not swallowed by GET /agents/:id", async () => {
    expect((await get("/agents/ranking", null)).status).toBe(401);
    const { status, body } = await get("/agents/ranking");
    expect(status).toBe(200);
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual(["ledgerline", "mine"]);
    expect(body.counts).toEqual({ all: 2, mine: 1 });
    expect(body.price).toMatchObject({ usdPerRun: 0.1, solUsdRate: null });
  });

  it("taskIds=a,b ranks by coverage and prices the missing runs", async () => {
    const { body } = await get("/agents/ranking?taskIds=a,b");
    expect(body.rows[0]).toMatchObject({ id: "ledgerline", rank: 1, coverage: { k: 1, n: 2, perTask: [true, false] }, score: 91.2, runCostUsd: 0.1 });
    expect(body.rows[1]).toMatchObject({ id: "mine", rank: null, coverage: { k: 0, n: 2 }, runCostUsd: 0.2, runCostLamports: 2_000_000, runCostSol: "0.002" });
    expect(body.price).toMatchObject({ usdPerRun: 0.1, solUsdRate: 100, priceSource: "test" });
  });

  it("tag expands into the selection; 503 when the catalog tables are missing", async () => {
    const { body } = await get("/agents/ranking?tag=stripe");
    expect(body.selection).toEqual({ taskIds: ["uuid-a", "uuid-b"], tag: "stripe" });
    expect(body.rows[0].coverage).toEqual({ k: 1, n: 2, perTask: [true, false] });
    store.catalogReady = false;
    expect((await get("/agents/ranking?tag=stripe")).status).toBe(503);
  });

  it("validates scope, taskIds and tag; maps a missing schema to 503", async () => {
    expect((await get("/agents/ranking?scope=x")).status).toBe(400);
    expect((await get("/agents/ranking?taskIds=a%20b")).status).toBe(400);
    expect((await get(`/agents/ranking?taskIds=${Array.from({ length: 51 }, (_, i) => `t${i}`).join(",")}`)).status).toBe(400);
    expect((await get("/agents/ranking?tag=Bad Tag")).status).toBe(400);
    expect((await get("/agents/ranking?scope=mine")).body.rows.map((r: { id: string }) => r.id)).toEqual(["mine"]);
    store.load = async () => {
      throw new SchemaNotReadyError("0001");
    };
    expect((await get("/agents/ranking")).status).toBe(503);
  });

  it("price feed down: rows keep the USD cost", async () => {
    rate = null;
    const { body } = await get("/agents/ranking?taskIds=a");
    expect(body.rows[1]).toMatchObject({ runCostUsd: 0.1, runCostSol: null });
  });
});
