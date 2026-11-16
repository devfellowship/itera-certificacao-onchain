/** The member gate on every route (plan 20261112-tma-c6-judge-calibration, task C6-S13-GATE). */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { FakeUsersStore } from "../domain/users-store.fake.js";
import { dflPrincipalId, type UsersStore } from "../domain/users-store.js";
import type { HumanLabelStore, ReviewRun } from "../self-declared/human-labels.js";
import { IAM_LEVEL_CACHE_TTL_MS } from "./iam-level-guard.js";
import { issueSessionToken } from "./session.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const MEMBER = "00000000-0000-4000-8000-00000000000a";
const DENY = "00000000-0000-4000-8000-00000000000b";
const NOROW = "00000000-0000-4000-8000-00000000000c";
const NULLLEVEL = "00000000-0000-4000-8000-00000000000d";
const dflToken = (uuid: string) => issueSessionToken(dflPrincipalId(uuid), Date.now(), "dfl", undefined, "human").token;
const siwsToken = issueSessionToken("5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG", Date.now(), "siws").token;

const run: ReviewRun = {
  runId: "1b6f3c2e-1d4a-4c8e-9f00-123456789abc", caseKey: "c", useCaseKey: "build/feature", originPinSha256: null, taskSummary: null, modelId: null,
  status: "pass", startedAt: "2026-11-15T10:00:00.000Z", steps: [], judge: null, workflow: null, mine: null, disagree: false,
};
const humanLabels: { store: HumanLabelStore; tenant: string } = {
  tenant: "devfellowship",
  store: {
    ready: async () => true,
    runTenant: async () => ({ tenant: "devfellowship" }),
    insert: async () => {
      throw new Error("not used");
    },
    labels: async () => [],
    queue: async () => [run],
    steps: async () => [],
  },
};

let server: Server;
let base = "";
let users: FakeUsersStore;
let min = 50;
let countingGets = 0;

async function seed(uuid: string, iamLevel: number | null) {
  await users.upsertDflLogin({ dflUserId: uuid, email: `${uuid}@example.test`, iamLevel });
}

beforeEach(async () => {
  min = 50;
  countingGets = 0;
  users = new FakeUsersStore();
  const get = users.get.bind(users);
  (users as UsersStore).get = async (id: string) => {
    countingGets += 1;
    return get(id);
  };
  await seed(MEMBER, 50);
  await seed(DENY, 0);
  await seed(NULLLEVEL, null);
  server = createApp(new FakeRepository(), { dflAuth: { users, config: () => ({ supabaseUrl: "https://x.example", anonKey: "k", minIamLevel: min }) }, humanLabels }).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const get = async (path: string, token?: string) => {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};
const QUEUE = "/review-queue?judge=async-wait-lifecycle";

describe("TMA_MIN_IAM_LEVEL on every route", () => {
  it("lets a member through to the review queue", async () => {
    const r = await get(QUEUE, dflToken(MEMBER));
    expect(r.status).toBe(200);
    expect(r.json.runs).toHaveLength(1);
  });
  it("refuses a principal below the level with 403 iam_level_too_low on the queue and on the labels", async () => {
    for (const path of [QUEUE, `/grader-results/human?run_id=${run.runId}`]) {
      const r = await get(path, dflToken(DENY));
      expect(r.status, path).toBe(403);
      expect(r.json.error).toBe("iam_level_too_low");
    }
  });
  it("refuses a stored null level and a principal with no users row (fail closed)", async () => {
    for (const uuid of [NULLLEVEL, NOROW]) {
      const r = await get(QUEUE, dflToken(uuid));
      expect(r.status).toBe(403);
      expect(r.json.error).toBe("iam_level_too_low");
    }
  });
  it("refuses a below-level principal on a write route too", async () => {
    const res = await fetch(`${base}/grader-results/human`, {
      method: "POST",
      headers: { authorization: `Bearer ${dflToken(DENY)}`, "content-type": "application/json" },
      body: JSON.stringify({ run_id: run.runId, judge_id: "async-wait-lifecycle", pass: true }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("iam_level_too_low");
  });
  it("does not touch a wallet (siws) session, an anonymous request, or /health", async () => {
    expect((await get(QUEUE, siwsToken)).json.error).not.toBe("iam_level_too_low");
    expect((await get(QUEUE)).status).toBe(401);
    expect((await get("/health")).status).toBe(200);
  });
  it("is off when TMA_MIN_IAM_LEVEL is 0: no lookup, nobody is refused", async () => {
    min = 0;
    const before = countingGets;
    expect((await get(QUEUE, dflToken(DENY))).status).toBe(200);
    expect(countingGets).toBe(before);
  });
  it("reads the users row once per principal inside the cache window", async () => {
    const t = dflToken(MEMBER);
    await get(QUEUE, t);
    const after = countingGets;
    await get(QUEUE, t);
    await get(QUEUE, t);
    expect(countingGets).toBe(after);
    expect(IAM_LEVEL_CACHE_TTL_MS).toBe(30_000);
  });
  it("lets a refused principal in at once after a new login stored a higher level (a refusal is not cached)", async () => {
    const t = dflToken(DENY);
    expect((await get(QUEUE, t)).status).toBe(403);
    await seed(DENY, 50);
    expect((await get(QUEUE, t)).status).toBe(200);
  });
  it("answers 503 and caches nothing when the users store fails", async () => {
    (users as UsersStore).get = async () => {
      throw new Error("db down");
    };
    const r = await get(QUEUE, dflToken(NOROW));
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("users_store_unavailable");
  });
});
