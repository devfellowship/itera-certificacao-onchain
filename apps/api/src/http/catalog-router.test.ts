import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeCatalogStore, type CatalogTask, type Tag } from "../domain/catalog-store.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { issueSessionToken } from "./auth.js";
import { createCatalogRouter } from "./catalog-router.js";

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
    expect((await get("/me", ME)).body).toEqual({ wallet: ME, displayName: null, handle: null, initials: "7X" });
    const r = await patch({ displayName: "Ada Lovelace", handle: "Ada_L" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ wallet: ME, displayName: "Ada Lovelace", handle: "ada_l", initials: "AL" });
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
});
