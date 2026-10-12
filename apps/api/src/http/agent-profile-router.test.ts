import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  agentBadge,
  buildMyResults,
  buildProfile,
  FakeProfileStore,
  type OwnTaskResult,
  type ProfileAgent,
  type ProfileData,
  type ProfileResult,
} from "../domain/agent-profile.js";
import { FakeGithubAgentsRepository } from "../domain/github-agents-repository.fake.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { GitHubConfigError } from "../github/app-client.js";
import { issueSessionToken, optionalWallet, requireWallet } from "./auth.js";
import { badgeMessage, renderBadge } from "./badge.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ME = "So11111111111111111111111111111111111111112";
const OWNER = "11111111111111111111111111111111";
const SIG_A = "4Kx9AbCdEfGhJkLmNpQrStUvWxYz123456789AbCdEfGhJkLmNpQrStUvWxYz123456789AbCdEfGhJkLmNpQraP2e";
const SIG_B = "8Ld2AbCdEfGhJkLmNpQrStUvWxYz123456789AbCdEfGhJkLmNpQrStUvWxYz123456789AbCdEfGhJkLmNpQrmW4c";

function agent(extra: Partial<ProfileAgent> = {}): ProfileAgent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "ledgerline",
    name: "Ledgerline",
    ownerWallet: OWNER,
    authorName: "Mara Okafor",
    description: "Fixes idempotency and replay bugs in payment webhooks.",
    model: "anthropic/claude-sonnet-4.6",
    modelLabel: null,
    modelRelease: "claude-sonnet-4.6",
    repoFullName: "mara/ledgerline",
    agentPath: ".",
    branch: "main",
    pinnedCommit: "c41e7d2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    latestCommit: "c41e7d2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    visibility: "listed",
    status: "active",
    listedAt: "2026-10-10T10:00:00Z",
    createdAt: "2026-10-10T09:00:00Z",
    ...extra,
  };
}

let seq = 0;
function result(task: string, score: number, extra: Partial<ProfileResult> = {}): ProfileResult {
  seq += 1;
  return {
    runId: `run-${seq}`,
    status: score === 100 ? "pass" : "fail",
    score,
    testsPassed: score === 100 ? 14 : 12,
    testsTotal: score === 100 ? 14 : 14,
    at: `2026-10-${String(10 + seq).padStart(2, "0")}T10:00:00Z`,
    taskKey: `uuid-${task}`,
    taskId: `uuid-${task}`,
    taskSlug: task,
    taskName: task.toUpperCase(),
    taskKind: "itera",
    taskOwnerWallet: null,
    taskTagIds: ["stripe-api"],
    proof: { status: "confirmed", txSig: SIG_A, nftMint: "mint" },
    evaluation: null,
    ...extra,
  };
}

const TAGS = [
  { id: "stripe-api", name: "Stripe API", kind: "tool" as const },
  { id: "idempotency", name: "Idempotency", kind: "concept" as const },
];

function data(extra: Partial<ProfileData> = {}): ProfileData {
  return { results: [], evaluations: [], tags: TAGS, ...extra };
}

describe("buildProfile", () => {
  it("shows the latest public result per task, counts tags per task and builds the stat strip", () => {
    const d = data({
      results: [
        result("a", 50, { at: "2026-10-01T00:00:00Z", taskTagIds: ["stripe-api", "idempotency"] }),
        result("a", 100, { at: "2026-10-02T00:00:00Z", taskTagIds: ["stripe-api", "idempotency"], proof: { status: "confirmed", txSig: SIG_B, nftMint: null } }),
        result("b", 100, { at: "2026-10-03T00:00:00Z", taskTagIds: ["stripe-api"] }),
        // A pending proof and an unissued run are not public evidence.
        result("c", 100, { proof: { status: "pending", txSig: null, nftMint: null } }),
        result("d", 100, { proof: null }),
        // A user task never appears.
        result("e", 100, { taskKind: "user", taskOwnerWallet: ME }),
      ],
    });
    const p = buildProfile({ agent: agent(), data: d, viewerWallet: null });
    expect(p.evidence.map((r) => [r.taskSlug, r.outcome, r.score, r.attestation?.short])).toEqual([
      ["b", "PASS", 100, "4Kx9…aP2e"],
      ["a", "PASS", 100, "8Ld2…mW4c"],
    ]);
    expect(p.tags).toEqual([
      { id: "stripe-api", name: "Stripe API", kind: "tool", count: 2 },
      { id: "idempotency", name: "Idempotency", kind: "concept", count: 1 },
    ]);
    // No evaluation row: the score is the mean of the best score per task; each standalone proof is an evaluation.
    expect(p.stats).toMatchObject({ score: 100, tasksEvaluated: 2, evaluations: 3 });
    expect(p.latestAttestation).toMatchObject({ network: "Solana devnet", status: "confirmed", txShort: "4Kx9…aP2e" });
    expect(p.latestAttestation?.explorerUrl).toBe(`https://solscan.io/tx/${SIG_A}?cluster=devnet`);
    expect(p.source).toMatchObject({ repoFullName: "mara/ledgerline", commitShort: "c41e7d2" });
    expect(p.model).toEqual({ id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", release: "claude-sonnet-4.6" });
    expect(p.badge).toEqual({ path: "/badge/agents/ledgerline.svg", markdownLinkPath: null });
  });

  it("the score is the latest issued public evaluation (same rule as the ranking) and links /e/:slug", () => {
    const ev = { id: "e1", slug: "ledgerline-7f3a", shortId: "7f3a", status: "issued", isPublic: true, issuedAt: "2026-10-12T00:00:00Z" };
    const d = data({
      results: [result("a", 100, { evaluation: ev })],
      evaluations: [
        { id: "e0", slug: "old", shortId: "old", score: 60, issuedAt: "2026-10-11T00:00:00Z", isPublic: true, taskCount: 1, passCount: 0, failCount: 1, invalidCount: 0 },
        { id: "e1", slug: "ledgerline-7f3a", shortId: "7f3a", score: 91.25, issuedAt: "2026-10-12T00:00:00Z", isPublic: true, taskCount: 1, passCount: 1, failCount: 0, invalidCount: 0 },
        { id: "e2", slug: "hidden", shortId: "hid", score: 1, issuedAt: "2026-10-13T00:00:00Z", isPublic: false, taskCount: 1, passCount: 0, failCount: 1, invalidCount: 0 },
      ],
    });
    const p = buildProfile({ agent: agent(), data: d, viewerWallet: null });
    expect(p.stats.score).toBe(91.3);
    expect(p.stats.evaluations).toBe(2);
    expect(p.evaluations.map((e) => [e.slug, e.profilePath])).toEqual([["ledgerline-7f3a", "/e/ledgerline-7f3a"], ["old", "/e/old"]]);
    expect(p.latestAttestation?.evaluationSlug).toBe("ledgerline-7f3a");
    expect(p.evidence[0]!.evaluation).toEqual({ slug: "ledgerline-7f3a", shortId: "7f3a" });
    expect(p.badge?.markdownLinkPath).toBe("/e/ledgerline-7f3a");
  });

  it("an owner without public evidence gets empty states, no badge", () => {
    const p = buildProfile({ agent: agent({ status: "draft" }), data: data(), viewerWallet: OWNER });
    expect(p.agent).toMatchObject({ isMine: true, draft: true });
    expect(p.evidence).toEqual([]);
    expect(p.stats).toEqual({ score: null, tasksEvaluated: 0, evaluations: 0, lastVerifiedAt: null });
    expect(p.latestAttestation).toBeNull();
    expect(p.badge).toBeNull();
  });
});

describe("buildMyResults", () => {
  const own: OwnTaskResult[] = [
    { agentId: "led", agentName: "Ledgerline", agentOwnerWallet: OWNER, taskId: "t1", taskName: "Ledger reconcile", score: 81.3, status: "fail", at: "2026-10-12T00:00:00Z" },
    { agentId: "settle", agentName: "Settlewise", agentOwnerWallet: ME, taskId: "t1", taskName: "Ledger reconcile", score: 75, status: "fail", at: "2026-10-12T00:00:00Z" },
    { agentId: "led", agentName: "Ledgerline", agentOwnerWallet: OWNER, taskId: "t2", taskName: "BRL rounding", score: 100, status: "pass", at: "2026-10-12T00:00:00Z" },
    { agentId: "tune", agentName: "Querytune", agentOwnerWallet: ME, taskId: "t2", taskName: "BRL rounding", score: 71.4, status: "fail", at: "2026-10-12T00:00:00Z" },
    { agentId: "other", agentName: "Other", agentOwnerWallet: OWNER, taskId: "t3", taskName: "Not run by led", score: 10, status: "fail", at: "2026-10-12T00:00:00Z" },
  ];

  it("lists the agent's results with the viewer's best OWN agent per task", () => {
    const rows = buildMyResults("led", ME, own);
    expect(rows.map((r) => [r.task.name, r.outcome, r.score, r.bestOwnAgent?.name, r.bestOwnAgent?.score])).toEqual([
      ["BRL rounding", "PASS", 100, "Querytune", 71.4],
      ["Ledger reconcile", "FAIL", 81.3, "Settlewise", 75],
    ]);
  });

  it("is empty when the agent has no result on the viewer's tasks", () => {
    expect(buildMyResults("nobody", ME, own)).toEqual([]);
  });
});

describe("badge", () => {
  it("renders a shields-style SVG with the brand colors, score and task count", () => {
    expect(badgeMessage(100, 1)).toBe("100.0 · 1 task");
    expect(badgeMessage(91.2, 6)).toBe("91.2 · 6 tasks");
    expect(badgeMessage(null, 2)).toBe("2 tasks");
    const svg = renderBadge(91.2, 6);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("testmyagent: 91.2 · 6 tasks");
    expect(svg).toContain('fill="#1c1916"');
    expect(svg).toContain('fill="#1c3a2a"');
    expect(svg).toContain('<text fill="#8fe9b1"');
    expect(svg).not.toContain("<script");
  });

  it("agentBadge is null for a private agent and for one without public evidence", () => {
    const d = data({ results: [result("a", 100)] });
    expect(agentBadge(agent(), d)).toEqual({ score: 100, taskCount: 1 });
    expect(agentBadge(agent({ visibility: "private" }), d)).toBeNull();
    expect(agentBadge(agent(), data())).toBeNull();
    expect(agentBadge(null, null)).toBeNull();
  });
});

describe("agent profile HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let store: FakeProfileStore;
  let broken = false;

  beforeEach(async () => {
    store = new FakeProfileStore();
    broken = false;
    store.agents = [
      agent(),
      agent({ id: "00000000-0000-4000-8000-000000000002", slug: "secret", name: "Secret", visibility: "private" }),
      agent({ id: "00000000-0000-4000-8000-000000000003", slug: "fresh", name: "Fresh", status: "draft" }),
    ];
    store.data.set(agent().id, data({ results: [result("a", 100), result("b", 100)] }));
    store.data.set("00000000-0000-4000-8000-000000000002", data({ results: [result("a", 100)] }));
    store.own = [{ agentId: agent().id, agentName: "Ledgerline", agentOwnerWallet: OWNER, taskId: "t1", taskName: "Mine", score: 90, status: "fail", at: "2026-10-12T00:00:00Z" }];
    store.evaluations = [{ slug: "ev-1", score: 83.33, taskCount: 3 }];
    const realLoad = store.load.bind(store);
    store.load = async (id) => {
      if (broken) throw new SchemaNotReadyError("0008");
      return realLoad(id);
    };
    server = createApp(new FakeRepository(), {
      github: { repo: new FakeGithubAgentsRepository(), github: () => { throw new GitHubConfigError("not configured"); }, requireWallet, stateSecret: () => "test-session-secret" },
      profile: {
        store,
        price: { solUsd: async () => ({ rate: 100, source: "test", at: "2026-10-12T00:00:00Z" }) },
        priceUsdPerRun: () => 0.1,
        requireWallet,
        optionalWallet,
      },
    }).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const auth = (wallet: string | null): Record<string, string> => (wallet ? { Authorization: `Bearer ${issueSessionToken(wallet).token}` } : {});
  async function getJson(path: string, wallet: string | null = null) {
    const res = await fetch(`${baseUrl}${path}`, { headers: auth(wallet) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  it("profile: logged-out read of a listed agent with evidence; by slug and by id; with the run price", async () => {
    const bySlug = await getJson("/agents/ledgerline/profile");
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.agent).toMatchObject({ name: "Ledgerline", initials: "LE", authorName: "Mara Okafor", isMine: false });
    expect(bySlug.body.stats).toMatchObject({ tasksEvaluated: 2, score: 100 });
    expect(bySlug.body.price).toMatchObject({ usdPerRun: 0.1, runCostSol: "0.001", priceSource: "test" });
    expect(bySlug.body.agent.authorWallet).toBe(OWNER);
    const byId = await getJson(`/agents/${agent().id}/profile`);
    expect(byId.body.agent.id).toBe(agent().id);
  });

  it("profile: private agents and agents without evidence look like unknown ones to everyone but the owner", async () => {
    for (const slug of ["secret", "fresh", "nope"]) {
      const r = await getJson(`/agents/${slug}/profile`, ME);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "not found" });
    }
    const owner = await getJson("/agents/secret/profile", OWNER);
    expect(owner.status).toBe(200);
    expect(owner.body.agent.isMine).toBe(true);
    const fresh = await getJson("/agents/fresh/profile", OWNER);
    expect(fresh.body.evidence).toEqual([]);
  });

  it("profile: a malformed key is a 404, and a missing migration is a 503", async () => {
    expect((await getJson("/agents/..%2Fx/profile")).status).toBe(404);
    broken = true;
    expect((await getJson("/agents/ledgerline/profile")).status).toBe(503);
  });

  it("my-results needs a wallet and answers the caller's own task rows", async () => {
    expect((await getJson("/agents/ledgerline/my-results")).status).toBe(401);
    const r = await getJson("/agents/ledgerline/my-results", ME);
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ task: { id: "t1", name: "Mine" }, outcome: "FAIL", score: 90, bestOwnAgent: null }]);
    expect((await getJson("/agents/secret/my-results", ME)).status).toBe(404);
  });

  async function getSvg(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), body: await res.text() };
  }

  it("badge: image/svg+xml with the score and the task count, cached 5 minutes", async () => {
    const r = await getSvg("/badge/agents/ledgerline.svg");
    expect(r.status).toBe(200);
    expect(r.type).toContain("image/svg+xml");
    expect(r.cache).toContain("max-age=300");
    expect(r.body).toContain("100.0 · 2 tasks");
    const byId = await getSvg(`/badge/agents/${agent().id}.svg`);
    expect(byId.status).toBe(200);
  });

  it("badge: private, unknown and malformed subjects answer the same generic 404 SVG", async () => {
    const bodies = new Set<string>();
    for (const path of ["/badge/agents/secret.svg", "/badge/agents/fresh.svg", "/badge/agents/nope.svg", "/badge/agents/x.png", "/badge/evaluations/nope.svg"]) {
      const r = await getSvg(path);
      expect(r.status).toBe(404);
      expect(r.type).toContain("image/svg+xml");
      bodies.add(r.body);
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toContain("not found");
  });

  it("badge: a public issued evaluation by /b/:slug.svg and /badge/evaluations/:slug.svg", async () => {
    for (const path of ["/b/ev-1.svg", "/badge/evaluations/ev-1.svg"]) {
      const r = await getSvg(path);
      expect(r.status).toBe(200);
      expect(r.body).toContain("83.3 · 3 tasks");
    }
  });
});
