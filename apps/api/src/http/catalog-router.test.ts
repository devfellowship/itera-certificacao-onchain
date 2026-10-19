import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeRankingStore, type RankAgent, type RankResult } from "../domain/agent-ranking.js";
import { FakeCatalogStore, type CatalogTask, type Tag } from "../domain/catalog-store.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { issueSessionToken } from "./auth.js";
import { createCatalogRouter } from "./catalog-router.js";
import type { EvaluationListRow, EvaluationsStore } from "../evaluations/store.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ME = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const TAGS: Tag[] = [
  { id: "stripe-api", name: "Stripe API", kind: "tool", sort: 1 },
  { id: "postgres", name: "Postgres", kind: "tool", sort: 2 },
  { id: "idempotency", name: "Idempotency", kind: "concept", sort: 1 },
];
const tag = (id: string) => TAGS.find((t) => t.id === id)!;

let n = 0;
function task(over: Partial<CatalogTask> & { runnable?: boolean } = {}): CatalogTask {
  n += 1;
  const { runnable = false, ...rest } = over;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    slug: `tsk_${n}`,
    kind: "itera",
    ownerWallet: null,
    name: `Task ${n}`,
    description: "A task.",
    visibility: "public",
    status: "ready",
    estMinutes: 5,
    tags: [],
    latest: {
      id: `v-${n}`,
      version: 1,
      source: "curated",
      labels: [],
      runnable,
      hiddenTestsCount: 5,
      packId: runnable ? "webhook-ledger" : null,
      packVersion: runnable ? "1" : null,
      installationId: null,
      repoFullName: null,
      branch: null,
      commitSha: null,
      repoPath: ".",
      fixtureDigest: null,
      hiddenDigest: null,
      validatedAt: null,
      createdAt: "2026-10-12T00:00:00.000Z",
    },
    agentsRunCount: 0,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...rest,
  };
}

let store: FakeCatalogStore;
let server: Server;
let base: string;

beforeEach(async () => {
  store = new FakeCatalogStore();
  store.tags = TAGS;
  store.tasks = [
    task({ slug: "tsk_webhook_dup", name: "Duplicate settlement webhook", tags: [tag("stripe-api"), tag("idempotency")], runnable: true }),
    task({ slug: "tsk_pg_index", name: "Missing index on hot query", tags: [tag("postgres")] }),
    task({
      slug: "my_ledger",
      kind: "user",
      ownerWallet: ME,
      visibility: "private",
      name: "Ledger reconcile",
      tags: [tag("stripe-api"), tag("postgres")],
    }),
    task({ slug: "their_task", kind: "user", ownerWallet: OTHER, visibility: "private", name: "Secret task", tags: [tag("postgres")] }),
  ];
  store.models = [
    {
      id: "anthropic/claude-haiku-4.5",
      label: "Claude Haiku 4.5",
      provider: "Anthropic",
      contextLength: 200000,
      promptPriceUsdPerM: 1,
      completionPriceUsdPerM: 5,
      supportsTools: true,
      enabled: true,
      sort: 1,
      openrouterCreatedAt: null,
      syncedAt: "2026-10-12T10:00:00.000Z",
      releases: [{ id: "anthropic/claude-4.5-haiku-20251001", isLatest: true, releasedAt: "2025-10-01T00:00:00.000Z" }],
    },
    {
      id: "openai/gpt-x",
      label: "GPT X",
      provider: "OpenAI",
      contextLength: null,
      promptPriceUsdPerM: null,
      completionPriceUsdPerM: null,
      supportsTools: true,
      enabled: false,
      sort: 100,
      openrouterCreatedAt: null,
      syncedAt: "2026-10-12T11:00:00.000Z",
      releases: [],
    },
  ];
  const app = express();
  app.use(express.json());
  app.use(createCatalogRouter(store));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

const auth = (wallet: string) => ({ Authorization: `Bearer ${issueSessionToken(wallet).token}` });
async function get(path: string, wallet?: string) {
  const res = await fetch(`${base}${path}`, { headers: wallet ? auth(wallet) : {} });
  return { status: res.status, body: (await res.json()) as any };
}

describe("GET /tasks", () => {
  it("anonymous: only public tasks, counts on the visible catalog", async () => {
    const { status, body } = await get("/tasks");
    expect(status).toBe(200);
    expect(body.tasks.map((t: any) => t.slug)).toEqual(["tsk_webhook_dup", "tsk_pg_index"]);
    expect(body.counts).toEqual({ all: 2, public: 2, mine: 0 });
    expect(body.tasks[0]).toMatchObject({ runnable: true, hiddenTestsCount: 5, mine: false, kind: "itera", source: "curated" });
    expect(body.tasks[0].tags).toEqual([
      { id: "stripe-api", name: "Stripe API", kind: "tool" },
      { id: "idempotency", name: "Idempotency", kind: "concept" },
    ]);
  });

  it("signed in: own private tasks first, never another wallet's", async () => {
    const { body } = await get("/tasks", ME);
    expect(body.tasks.map((t: any) => t.slug)).toEqual(["my_ledger", "tsk_webhook_dup", "tsk_pg_index"]);
    expect(body.counts).toEqual({ all: 3, public: 2, mine: 1 });
    expect(body.tasks[0].mine).toBe(true);
  });

  it("filters: source, tag, kind, runnable, search", async () => {
    expect((await get("/tasks?source=mine", ME)).body.tasks.map((t: any) => t.slug)).toEqual(["my_ledger"]);
    expect((await get("/tasks?source=curated", ME)).body.tasks).toHaveLength(2);
    expect((await get("/tasks?source=public", ME)).body.tasks).toHaveLength(2);
    expect((await get("/tasks?tag=postgres", ME)).body.tasks.map((t: any) => t.slug)).toEqual(["my_ledger", "tsk_pg_index"]);
    expect((await get("/tasks?kind=user", ME)).body.tasks.map((t: any) => t.slug)).toEqual(["my_ledger"]);
    expect((await get("/tasks?runnable=true")).body.tasks.map((t: any) => t.slug)).toEqual(["tsk_webhook_dup"]);
    expect((await get("/tasks?q=IDEMPOTENCY")).body.tasks.map((t: any) => t.slug)).toEqual(["tsk_webhook_dup"]);
    expect((await get("/tasks?search=hot")).body.tasks.map((t: any) => t.slug)).toEqual(["tsk_pg_index"]);
    // counts ignore the filters
    expect((await get("/tasks?tag=postgres", ME)).body.counts).toEqual({ all: 3, public: 2, mine: 1 });
  });

  it("rejects bad filter values", async () => {
    expect((await get("/tasks?source=everyone")).status).toBe(400);
    expect((await get("/tasks?kind=x")).status).toBe(400);
    expect((await get("/tasks?runnable=yes")).status).toBe(400);
  });

  it("answers 503 when 0007 is not applied", async () => {
    store.listVisibleTasks = async () => {
      throw new SchemaNotReadyError("0007_catalog.sql");
    };
    expect((await get("/tasks")).status).toBe(503);
  });
});

describe("GET /tasks/:id", () => {
  it("by slug or id; private task of another wallet is a 404", async () => {
    const pub = await get("/tasks/tsk_webhook_dup");
    expect(pub.status).toBe(200);
    expect(pub.body.task.latestVersion).toMatchObject({ packId: "webhook-ledger", packVersion: "1", runnable: true });
    const byId = await get(`/tasks/${pub.body.task.id}`);
    expect(byId.body.task.slug).toBe("tsk_webhook_dup");
    expect((await get("/tasks/their_task", ME)).status).toBe(404);
    expect((await get("/tasks/my_ledger")).status).toBe(404);
    expect((await get("/tasks/my_ledger", ME)).status).toBe(200);
  });

  it("shows the GitHub pin to the owner only", async () => {
    const mine = store.tasks.find((t) => t.slug === "my_ledger")!;
    mine.latest = { ...mine.latest!, source: "github", installationId: 42, repoFullName: "me/tasks", branch: "main", commitSha: "a".repeat(40), repoPath: "ledger" };
    const { body } = await get("/tasks/my_ledger", ME);
    expect(body.task.latestVersion.github).toEqual({ installationId: 42, repo: "me/tasks", branch: "main", commitSha: "a".repeat(40), path: "ledger" });
    expect(body.task.latestVersion.sourceLink).toEqual({ provider: "GitHub", repo: "me/tasks", path: "ledger", commit: "a".repeat(40) });
  });

  it("returns the verified curated source only to the owner", async () => {
    const mine = store.tasks.find((t) => t.slug === "my_ledger")!;
    mine.latest = { ...mine.latest!, source: "curated", packId: "dfl-html-report", packVersion: "1" };
    const { body } = await get("/tasks/my_ledger", ME);
    expect(body.task.latestVersion.sourceLink).toEqual({
      provider: "GitHub", repo: "devfellowship/itera-certificacao-onchain", path: "benchmarks/dfl-html-report", commit: "25971880c35c590e2a8cfa5ba703d7c68cd79e90",
    });
  });
});

describe("GET /tags", () => {
  it("counts tasks in the caller's visible catalog; kind filter", async () => {
    const anon = await get("/tags");
    expect(anon.body.tags).toEqual([
      { id: "stripe-api", name: "Stripe API", kind: "tool", count: 1 },
      { id: "postgres", name: "Postgres", kind: "tool", count: 1 },
      { id: "idempotency", name: "Idempotency", kind: "concept", count: 1 },
    ]);
    const mine = await get("/tags?kind=tool", ME);
    expect(mine.body.tags).toEqual([
      { id: "stripe-api", name: "Stripe API", kind: "tool", count: 2 },
      { id: "postgres", name: "Postgres", kind: "tool", count: 2 },
    ]);
    expect((await get("/tags?kind=x")).status).toBe(400);
  });
});

describe("GET /models", () => {
  it("enabled models from the DB, backward compatible fields", async () => {
    const { body } = await get("/models");
    expect(body.default).toBe("anthropic/claude-haiku-4.5");
    expect(body.source).toBe("db");
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      id: "anthropic/claude-haiku-4.5",
      label: "Claude Haiku 4.5",
      provider: "Anthropic",
      enabled: true,
      pricing: { promptUsdPerM: 1, completionUsdPerM: 5 },
      releases: [{ id: "anthropic/claude-4.5-haiku-20251001", isLatest: true }],
    });
    expect(body.syncedAt).toBe("2026-10-12T11:00:00.000Z");
  });

  it("all=1 includes disabled models", async () => {
    expect((await get("/models?all=1")).body.models.map((m: any) => m.id)).toEqual(["anthropic/claude-haiku-4.5", "openai/gpt-x"]);
  });

  it("falls back to the static list when 0007 is not applied", async () => {
    store.listModels = async () => {
      throw new SchemaNotReadyError("0007_catalog.sql");
    };
    const { status, body } = await get("/models");
    expect(status).toBe(200);
    expect(body.source).toBe("static");
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models[0]).toHaveProperty("id");
    expect(body.models[0]).toHaveProperty("label");
  });
});

describe("GET/PATCH /me", () => {
  const patch = async (body: unknown, wallet = ME) => {
    const res = await fetch(`${base}/me`, { method: "PATCH", headers: { ...auth(wallet), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("needs a session", async () => {
    expect((await get("/me")).status).toBe(401);
  });

  it("defaults before a profile exists, then updates", async () => {
    expect((await get("/me", ME)).body).toEqual({ wallet: ME, username: null, displayName: null, handle: null, avatarUrl: null, bio: null, initials: "7X", stats: { agents: 0, tasks: expect.any(Number) } });
    const r = await patch({ displayName: "Ada Lovelace", handle: "Ada_L" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ wallet: ME, username: "ada_l", displayName: "Ada Lovelace", handle: "ada_l", avatarUrl: null, bio: null, initials: "AL" });
    expect((await patch({ handle: null })).body.handle).toBeNull();
    expect((await get("/me", ME)).body.displayName).toBe("Ada Lovelace");
  });

  it("validates and rejects a taken handle", async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch({ handle: "x" })).status).toBe(400);
    expect((await patch({ displayName: "a".repeat(61) })).status).toBe(400);
    await patch({ handle: "taken" }, OTHER);
    expect((await patch({ handle: "taken" })).status).toBe(409);
  });

  it("U36: username is 3 to 30 of [a-z0-9_-], not reserved; avatarUrl only clears", async () => {
    expect((await patch({ username: "ab" })).status).toBe(400);
    expect((await patch({ username: "a".repeat(31) })).status).toBe(400);
    expect((await patch({ username: "bad name" })).status).toBe(400);
    expect((await patch({ username: "Admin" })).body.error).toMatch(/reserved/);
    const ok = await patch({ username: "Grace_H-1" });
    expect(ok.status).toBe(200);
    expect(ok.body.username).toBe("grace_h-1");
    expect(ok.body.handle).toBe("grace_h-1");
    expect((await patch({ avatarUrl: "https://evil.test/x.png" })).status).toBe(400);
    expect((await patch({ avatarUrl: null })).body.avatarUrl).toBeNull();
    await patch({ username: "dup_name" }, OTHER);
    const taken = await patch({ username: "DUP_NAME" });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatch(/taken/);
  });

  it("U36: bio ≤ 80, username availability, public user page", async () => {
    expect((await patch({ bio: "x".repeat(81) })).status).toBe(400);
    expect((await patch({ username: "grace", bio: "Building payment agents." })).body.bio).toBe("Building payment agents.");
    const avail = async (n: string, w?: string) => (await get(`/usernames/${n}/available`, w)).body;
    expect(await avail("grace")).toMatchObject({ available: false, reason: "taken" });
    expect(await avail("grace", ME)).toMatchObject({ available: true });
    expect(await avail("someone_new")).toMatchObject({ available: true });
    expect(await avail("admin")).toMatchObject({ available: false, reason: "reserved" });
    expect(await avail("a")).toMatchObject({ available: false, reason: "invalid" });
    const page = await get("/public/users/grace");
    expect(page.status).toBe(200);
    expect(page.body.user).toMatchObject({ username: "grace", bio: "Building payment agents." });
    expect((await get("/public/users/nobody_here")).status).toBe(404);
  });
});

describe("model access (U21)", () => {
  it("GET /models/:id/access reads the allow-list", async () => {
    expect((await get("/models/anthropic%2Fclaude-haiku-4.5/access")).body).toEqual({ modelId: "anthropic/claude-haiku-4.5", accessible: true, reason: "allow_listed" });
    expect((await get("/models/openai/gpt-x/access")).body).toEqual({ modelId: "openai/gpt-x", accessible: false, reason: "not_enabled" });
    expect((await get("/models/nope/nope/access")).body).toMatchObject({ accessible: false, reason: "unknown_model" });
  });

  it("POST /admin/models/sync: admin wallets only", async () => {
    const app = express();
    app.use(express.json());
    let calls = 0;
    app.use(
      createCatalogRouter(store, {
        adminWallets: () => [ME],
        syncModels: async () => {
          calls += 1;
          return { fetched: 1, inserted: 0, updated: 1, newReleases: 0, syncedAt: "2026-10-12T20:00:00.000Z" };
        },
      }),
    );
    const srv = app.listen(0);
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/admin/models/sync`;
    try {
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: auth(OTHER) })).status).toBe(403);
      const ok = await fetch(url, { method: "POST", headers: auth(ME) });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).updated).toBe(1);
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("GET /tasks?include=overview (U35)", () => {
  const agent = (id: string, name: string, ownerWallet: string, over: Partial<RankAgent> = {}): RankAgent => ({
    id, slug: null, name, ownerWallet, authorName: null, description: null, model: "m", modelLabel: null,
    visibility: "listed", status: "active", listedAt: null, createdAt: null, ...over,
  });
  const result = (agentId: string, taskKeys: string[], score: number, over: Partial<RankResult> = {}): RankResult => ({
    agentId, runId: `${agentId}-${taskKeys[0]}-${score}`, runOwnerWallet: null, score, at: "2026-10-12T10:00:00.000Z", issued: true,
    taskKeys, taskKind: "itera", taskOwnerWallet: null, ...over,
  });
  const evaluation = (id: string, ownerWallet: string, agentId: string, taskId: string, taskSlug: string, over: Partial<EvaluationListRow> = {}): EvaluationListRow => ({
    id, slug: null, shortId: id.slice(0, 8), ownerWallet, agentId, agentVersionId: "11111111-1111-4111-8111-111111111111",
    modelId: "model", modelRelease: null, tasks: [{ taskId, taskVersionId: null, slug: taskSlug, name: "Task", packId: "pack", packVersion: "1", isPublic: false }],
    status: "graded", paymentKind: "free_byok", taskCount: 1, priceUsdPerRun: 0, feeUsd: 0, feeLamports: 0,
    solUsdRate: 0, priceSource: "historical_import", paymentId: null, txSig: null, score: 92, passCount: 1,
    failCount: 0, invalidCount: 0, testsPassed: 4, testsTotal: 5, manifestSha256: null, isPublic: false,
    freeRetriesUsed: 0, createdAt: "2026-10-19T10:00:00.000Z", startedAt: null, completedAt: null, issuedAt: null,
    cancelledAt: null, agentName: `Agent ${agentId}`, agentSlug: null, agentOwnerWallet: ownerWallet, agentAuthorName: "Tainan", ...over,
  });
  const evaluationsStore = (rows: EvaluationListRow[]): Pick<EvaluationsStore, "listForWallet" | "listForTaskAndWallet"> => ({
    listForWallet: async (wallet) => rows.filter((e) => e.ownerWallet === wallet),
    listForTaskAndWallet: async (taskId, taskSlug, wallet) => rows.filter((e) => e.ownerWallet === wallet && e.tasks.some((t) => t.taskId === taskId || t.slug === taskSlug)),
  });

  async function overview(rank: FakeRankingStore | undefined, path = "/tasks?include=overview", wallet?: string) {
    const app = express();
    app.use(express.json());
    app.use(createCatalogRouter(store, { ranking: rank }));
    const srv = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}${path}`;
      const res = await fetch(url, { headers: wallet ? auth(wallet) : {} });
      return (await res.json()) as any;
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }

  it("adds author, agentsCount and the best result, with the ranking visibility rules", async () => {
    store.profiles.set(ME, { wallet: ME, displayName: "Bruno Lima", handle: "bruno", avatarUrl: null, avatarKey: null, bio: null, createdAt: null, updatedAt: null });
    const dup = store.tasks[0]!;
    const mine = store.tasks[2]!;
    const rank = new FakeRankingStore();
    rank.data = {
      agents: [agent("a1", "Ledgerline", OTHER, { authorName: "Mara" }), agent("a2", "Patchwright", OTHER), agent("a3", "Hidden", OTHER, { visibility: "private" }), agent("a4", "Settlewise", ME)],
      results: [
        result("a1", [dup.id, dup.slug], 90),
        result("a2", [dup.id, dup.slug], 100),
        result("a1", [dup.id, dup.slug], 100, { at: "2026-10-12T11:00:00.000Z" }),
        result("a3", [dup.id, dup.slug], 100), // private agent of another wallet: not shown
        result("a4", [mine.id, mine.slug], 81.3, { issued: false, runOwnerWallet: ME, taskKind: "user", taskOwnerWallet: ME }),
      ],
      evaluations: [],
    };
    const body = await overview(rank, "/tasks?include=overview", ME);
    const byslug = Object.fromEntries(body.tasks.map((t: any) => [t.slug, t]));
    expect(byslug.tsk_webhook_dup.author).toMatchObject({ isDfl: true, name: "DevFellowship", wallet: null });
    expect(byslug.tsk_webhook_dup.author.avatarUrl).toContain("dfl-icon-180.png");
    expect(byslug.tsk_webhook_dup.agentsCount).toBe(2);
    // Tie at 100: the newest result wins.
    expect(byslug.tsk_webhook_dup.bestResult).toMatchObject({ score: 100, agent: { id: "a1", name: "Ledgerline", author: { name: "Mara" } } });
    expect(byslug.tsk_pg_index.bestResult).toBeNull();
    expect(byslug.my_ledger.author).toMatchObject({ isDfl: false, name: "Bruno Lima", handle: "bruno", wallet: ME });
    expect(byslug.my_ledger.bestResult).toMatchObject({ score: 81.3, agent: { name: "Settlewise" } });
  });

  it("an unranked task (open tests) shows no best result, and a user task of another wallet never leaks", async () => {
    const dup = store.tasks[0]!;
    const rank = new FakeRankingStore();
    rank.data = { agents: [agent("a1", "Ledgerline", OTHER)], results: [result("a1", [dup.id, dup.slug], 99, { taskRanked: false })], evaluations: [] };
    const body = await overview(rank);
    expect(body.tasks[0].bestResult).toBeNull();
    expect(body.tasks[0].agentsCount).toBe(0);
  });

  it("shows open-test history as unranked activity with real evaluation and agent counts", async () => {
    const dup = store.tasks[0]!;
    dup.latest!.labels = ["open-tests"];
    const rank = new FakeRankingStore();
    rank.data = { agents: [agent("a1", "Ledgerline", ME), agent("a2", "Patchwright", ME)], results: [result("a1", [dup.id, dup.slug], 99, { taskRanked: false, runOwnerWallet: ME })], evaluations: [] };
    const rows = [
      evaluation("11111111-0000-4000-8000-000000000001", ME, "a1", dup.id, dup.slug),
      evaluation("11111111-0000-4000-8000-000000000002", ME, "a2", dup.id, dup.slug, { score: 80, passCount: 0, failCount: 1 }),
      evaluation("11111111-0000-4000-8000-000000000003", ME, "a1", dup.id, dup.slug, { score: null, passCount: 0, invalidCount: 1 }),
    ];
    const app = express();
    app.use(createCatalogRouter(store, { ranking: rank, evaluations: evaluationsStore(rows) }));
    const srv = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/tasks?include=overview`, { headers: auth(ME) });
      const body = await res.json() as any;
      expect(body.tasks.find((t: any) => t.id === dup.id)).toMatchObject({ bestResult: null, agentsCount: 2, evaluationCount: 3, rankingEligible: false });
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("serves owner-scoped task evaluation history and hides another wallet's private task", async () => {
    const mine = store.tasks[2]!;
    mine.status = "ready";
    mine.latest!.labels = ["open-tests"];
    const rows = [evaluation("22222222-0000-4000-8000-000000000001", ME, "a1", mine.id, mine.slug)];
    const app = express();
    app.use(createCatalogRouter(store, { evaluations: evaluationsStore(rows) }));
    const srv = app.listen(0);
    const endpoint = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/tasks/${mine.id}/evaluations`;
    try {
      expect((await fetch(endpoint)).status).toBe(401);
      expect((await fetch(endpoint, { headers: auth(OTHER) })).status).toBe(404);
      const response = await fetch(endpoint, { headers: auth(ME) });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.task).toMatchObject({ id: mine.id, mine: true, visibility: "private" });
      expect(body.summary).toEqual({ evaluations: 1, agents: 1, rankingEligible: false });
      expect(body.evaluations[0]).toMatchObject({ id: rows[0]!.id, score: 92, counts: { pass: 1, fail: 0, invalid: 0 }, tests: { passed: 4, total: 5 }, agent: { id: "a1" } });

      rows.length = 0;
      const empty = await (await fetch(endpoint, { headers: auth(ME) })).json() as any;
      expect(empty.evaluations).toEqual([]);
      expect(empty.summary.evaluations).toBe(0);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("without a ranking store (or when it fails) the task still carries its author; plain GET /tasks is unchanged", async () => {
    const body = await overview(undefined);
    expect(body.tasks[0].author.isDfl).toBe(true);
    expect(body.tasks[0].bestResult).toBeNull();
    const failing = new FakeRankingStore();
    failing.load = async () => {
      throw new SchemaNotReadyError("runs");
    };
    expect((await overview(failing)).tasks).toHaveLength(2);
    expect((await get("/tasks")).body.tasks[0].author).toBeUndefined();
  });
});
