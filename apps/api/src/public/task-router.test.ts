import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeReputationStore } from "../domain/reputation-store.js";
import { buildTaskProfile, resultsView, schemasDownload } from "./task-profile.js";
import { createPublicTaskRouter } from "./task-router.js";
import { FakePublicTaskStore, type PublicTaskSource, type PublicTaskVersionRow, type TaskResultRow } from "./task-store.js";

const TOOLS = [
  { name: "create_customer", description: "Create a customer.", inputSchema: { type: "object", properties: { email: { type: "string" }, name: { type: "string" } }, required: ["email"] } },
  { name: "list_charges", description: "List charges.", inputSchema: { type: "object", properties: { customer_id: { type: "string" } } } },
  { name: "delete_customer", description: "Delete a customer.", inputSchema: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] } },
];

const baseContract = {
  editable_paths: ["src/**"],
  protected_paths: ["tests/**", "package.json"],
  est_minutes: 6,
  agent: { timeout_sec: 300 },
  verifier: { cmd: ["npx", "vitest", "run", "{tests}", "--reporter=json", "--outputFile={report}"], timeout_sec: 120 },
  profile: { goal: "Settle each event once.", done_when: ["a", "b"], instruction: "Fix POST /events.\nSecond line.", public_tests_count: 3 },
};

const server = (extra: Record<string, unknown> = {}) => ({
  name: "stripe-sandbox",
  catalog: "stripe-sandbox@2",
  transport: "http",
  seed: "mcp/stripe-sandbox",
  seed_digest: "ab".repeat(32),
  allowed_tools: ["create_customer", "list_charges"],
  expose_state_to_scorer: true,
  tools_snapshot: TOOLS,
  snapshot_captured_at: "2026-10-12T12:00:00.000Z",
  ...extra,
});

const version = (n: number, over: Partial<PublicTaskVersionRow> = {}): PublicTaskVersionRow => ({
  id: `v${n}`,
  version: n,
  source: "curated",
  contract: { ...baseContract, environment: { tools: { builtin: ["read", "edit", "bash"], mcp: [server()] }, run_egress: ["model-gateway", "mcp"], secrets: [], resources: { cpus: 2, memory_mb: 2048 } } },
  labels: ["sealed-tests"],
  hiddenTestsCount: 5,
  runnable: true,
  fixtureDigest: null,
  hiddenDigest: null,
  packId: "p",
  packVersion: "1",
  repoFullName: null,
  commitSha: null,
  repoPath: ".",
  createdAt: `2026-10-1${n}T10:00:00.000Z`,
  ...over,
});

const source = (versions: PublicTaskVersionRow[]): PublicTaskSource => ({
  task: { id: "11111111-1111-4111-8111-111111111111", slug: "tsk_demo", name: "Demo task", description: "Short.", estMinutes: 6, tags: [{ id: "stripe-api", name: "Stripe API", kind: "tool" }], createdAt: "2026-10-10T10:00:00.000Z" },
  versions,
});

const row = (id: string, agent: string, status: string, score: number | null, issuedAt: string, taskVersion: number | null = 2): TaskResultRow => ({
  runId: id,
  status,
  scoreTotal: score,
  startedAt: "2026-10-12T10:00:00.000Z",
  claimedAt: "2026-10-12T10:00:00.000Z",
  completedAt: "2026-10-12T10:05:00.000Z",
  agentId: agent,
  agentName: `Agent ${agent}`,
  agentSlug: `agent-${agent}`,
  modelLabel: "Model",
  evaluationSlug: `ev-${id}`,
  issuedAt,
  taskVersion,
});

const opts = { costCapUsd: 0.5, runFeeUsd: 0.1, links: { webBaseUrl: "https://web.test", apiBaseUrl: "https://api.test" } };

describe("buildTaskProfile", () => {
  it("shows exactly the pinned list_tools snapshot, filtered by the allowed tools", () => {
    const p = buildTaskProfile(source([version(2)]), opts)!;
    const s = p.mcp.servers[0]!;
    expect(s.snapshot.status).toBe("pinned");
    expect(s.tools.map((t) => t.name)).toEqual(["create_customer", "list_charges"]);
    // counts only, never the name of a tool the agent cannot call
    expect(s.notExposedCount).toBe(1);
    expect(JSON.stringify(p)).not.toContain("delete_customer");
    expect(s.tools[0]!.params).toEqual(["email", "name"]);
    expect(s.tools[0]!.required).toEqual(["email"]);
    expect(s.source).toBe("catalog");
    expect(s.version).toBe("v2");
    expect(s.scorerReadsState).toBe(true);
    expect(p.mcp.scorerReads).toEqual(["stripe-sandbox"]);
    expect(p.mcp.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.limits.network).toBe("model-gateway+mcp");
  });

  it("changes the schema digest when one tool of the snapshot changes", () => {
    const a = buildTaskProfile(source([version(2)]), opts)!;
    const changed = version(2, { contract: { ...baseContract, environment: { tools: { builtin: ["read"], mcp: [server({ tools_snapshot: [{ ...TOOLS[0], description: "Create a customer!" }, TOOLS[1], TOOLS[2]] })] } }, run_egress: ["model-gateway", "mcp"] } });
    const b = buildTaskProfile(source([changed]), opts)!;
    expect(a.mcp.snapshotDigest).not.toBe(b.mcp.snapshotDigest);
  });

  it("marks a server without a snapshot as pending and lists only the declared tool names", () => {
    const pending = version(2, { contract: { ...baseContract, environment: { tools: { builtin: ["read"], mcp: [server({ tools_snapshot: undefined })] }, run_egress: ["model-gateway", "mcp"] } } });
    const p = buildTaskProfile(source([pending]), opts)!;
    const s = p.mcp.servers[0]!;
    expect(s.snapshot.status).toBe("pending");
    expect(s.tools).toEqual([]);
    expect(s.allowedToolNames).toEqual(["create_customer", "list_charges"]);
    expect(p.mcp.snapshotDigest).toBeNull();
  });

  it("never carries an endpoint, token, secret value or seed content", () => {
    const withSecrets = version(2, { contract: { ...baseContract, environment: { tools: { builtin: ["read"], mcp: [server({ secrets: ["STRIPE_TEST_KEY"], image: "itera/x@sha256:" + "0".repeat(64), command: ["run"] })] }, secrets: ["STRIPE_TEST_KEY"], run_egress: ["model-gateway", "mcp"] } } });
    const text = JSON.stringify(buildTaskProfile(source([withSecrets]), opts));
    expect(text).not.toMatch(/sha256:0{64}/);
    expect(text).not.toContain("itera/x");
    expect(text).not.toMatch(/token|endpoint|bearer/i);
    // secret NAMES are public limits; values never exist in the contract
    expect(buildTaskProfile(source([withSecrets]), opts)!.limits.secrets).toEqual(["STRIPE_TEST_KEY"]);
  });

  it("renders a task with no environment: every built-in tool, no server", () => {
    const bare = version(1, { contract: { editable_paths: ["src/**"] } });
    const p = buildTaskProfile(source([bare]), opts)!;
    expect(p.mcp.servers).toEqual([]);
    expect(p.tools.every((t) => t.allowed)).toBe(true);
    expect(p.goal.text).toBe("Short.");
    expect(p.input.instruction.text).toBeNull();
    expect(p.limits.runTimeoutSec).toBeNull();
  });

  it("turns off the built-in tools the task does not allow, but keeps them listed", () => {
    const p = buildTaskProfile(source([version(2)]), opts)!;
    expect(p.tools.map((t) => [t.id, t.allowed])).toEqual([["read", true], ["write", false], ["edit", true], ["bash", true], ["search", false], ["list", false], ["todo", false]]);
  });

  it("reads the limits, tests label, scoring and price", () => {
    const p = buildTaskProfile(source([version(2)]), opts)!;
    expect(p.limits).toMatchObject({ runTimeoutSec: 300, costCapUsd: 0.5, estMinutes: 6, editablePaths: ["src/**"] });
    expect(p.limits.resources).toEqual({ cpus: 2, memoryMb: 2048, pids: null });
    expect(p.tests).toEqual({ label: "sealed", hiddenCount: 5, publicCount: 3 });
    expect(p.output.checkedBy).toBe("npx vitest run --reporter=json");
    // Score version 2 (TMA-QC = B): hidden ratio × 100, behind the gates.
    expect(p.scoring.parts.map((x) => x.points)).toEqual([100]);
    expect(p.scoring.version).toBe(2);
    expect(p.scoring.gates).toHaveLength(4);
    expect(p.price.usdPerRun).toBe(0.1);
    const open = buildTaskProfile(source([version(2, { labels: ["open-tests"] })]), opts)!;
    expect(open.tests.label).toBe("open");
  });

  it("pins the page to ?v and describes what changed between versions", () => {
    const v1 = version(1, { contract: { ...baseContract, environment: { tools: { builtin: ["read"], mcp: [] } } } });
    const v2 = version(2, { hiddenDigest: "x" });
    const src = source([v2, v1]);
    const p2 = buildTaskProfile(src, opts)!;
    expect(p2.version).toMatchObject({ number: 2, latest: 2, isLatest: true });
    expect(p2.version.history[0]!.changed).toEqual(["Environment", "Tests"]);
    expect(p2.version.history[1]!.changed).toEqual([]);
    const p1 = buildTaskProfile(src, { ...opts, version: 1 })!;
    expect(p1.version).toMatchObject({ number: 1, latest: 2, isLatest: false });
    expect(p1.mcp.servers).toEqual([]);
    expect(p1.version.digests.environment).not.toBe(p2.version.digests.environment);
  });

  it("builds the schemas download from the same snapshot", () => {
    const p = buildTaskProfile(source([version(2)]), opts)!;
    const d = schemasDownload(p);
    expect(d.servers[0]!.tools.map((t) => t.name)).toEqual(["stripe-sandbox_create_customer", "stripe-sandbox_list_charges"]);
    expect(d.schemaDigest).toBe(p.mcp.snapshotDigest);
  });
});

describe("resultsView", () => {
  it("is empty without runs", () => {
    expect(resultsView([])).toMatchObject({ agentsEvaluated: 0, runs: 0, passRate: null, medianScore: null, medianDurationMs: null, leaderboard: [] });
  });

  it("counts outcomes, ranks agents by mean score and keeps INVALID out of the score", () => {
    const r = resultsView([
      row("1", "a", "pass", 100, "2026-10-12T11:00:00Z"),
      row("2", "a", "fail", 60, "2026-10-12T12:00:00Z"),
      row("3", "b", "pass", 90, "2026-10-12T10:00:00Z"),
      row("4", "c", "timeout", null, "2026-10-12T09:00:00Z"),
    ]);
    expect(r.outcomes).toEqual({ pass: 2, fail: 1, invalid: 1 });
    expect(r.agentsEvaluated).toBe(3);
    expect(r.passRate).toBe(0.5);
    expect(r.medianScore).toBe(90);
    expect(r.medianDurationMs).toBe(300000);
    expect(r.leaderboard.map((l) => [l.rank, l.agentName, l.score, l.outcome])).toEqual([
      [1, "Agent b", 90, "PASS"],
      [2, "Agent a", 80, "FAIL"],
      [3, "Agent c", null, "INVALID"],
    ]);
  });

  it("limits the board to ten agents", () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(String(i), `a${i}`, "pass", 50 + i, "2026-10-12T11:00:00Z"));
    expect(resultsView(rows).leaderboard).toHaveLength(10);
  });
});

describe("GET /public/tasks/:slug", () => {
  const store = new FakePublicTaskStore();
  const rep = new FakeReputationStore();
  let base = "";
  let srv: ReturnType<express.Express["listen"]>;

  beforeAll(async () => {
    store.tasks = [source([version(2), version(1)])];
    store.results.set("11111111-1111-4111-8111-111111111111", [row("1", "a", "pass", 100, "2026-10-12T11:00:00Z", 2), row("2", "b", "fail", 40, "2026-10-12T11:00:00Z", 1)]);
    rep.inputs.set("t", { taskId: "11111111-1111-4111-8111-111111111111", slug: "tsk_demo", ownerWallet: null, kind: "itera", distinctWallets: 2, runs: 2, feedbackTotal: 0, feedbackYes: 0 });
    const app = express();
    app.use(createPublicTaskRouter({ store, reputation: rep, costCapUsd: 0.5, runFeeUsd: 0.1, webBaseUrl: "https://web.test", apiBaseUrl: "https://api.test" }));
    await new Promise<void>((r) => {
      srv = app.listen(0, () => r());
    });
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => srv.close());

  it("serves the profile by slug and by id, with CORS and reputation", async () => {
    const res = await fetch(`${base}/public/tasks/tsk_demo`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as ReturnType<typeof buildTaskProfile> & object;
    expect(body.slug).toBe("tsk_demo");
    expect(body.version.number).toBe(2);
    expect(body.reputation).toMatchObject({ distinctWallets: 2, runs: 2, curatedByItera: true });
    expect(body.results.runs).toBe(1);
    expect(body.resultsAll.runs).toBe(2);
    expect(body.links.web).toBe("https://web.test/tasks/tsk_demo");
    const byId = await fetch(`${base}/public/tasks/11111111-1111-4111-8111-111111111111`);
    expect(byId.status).toBe(200);
  });

  it("serves an old version with ?v and 404s an unknown one", async () => {
    const old = (await (await fetch(`${base}/public/tasks/tsk_demo?v=1`)).json()) as { version: { number: number; isLatest: boolean } };
    expect(old.version).toMatchObject({ number: 1, isLatest: false });
    expect((await fetch(`${base}/public/tasks/tsk_demo?v=9`)).status).toBe(404);
    expect((await fetch(`${base}/public/tasks/tsk_demo?v=abc`)).status).toBe(404);
  });

  it("answers one generic 404 for unknown and private tasks", async () => {
    const a = await fetch(`${base}/public/tasks/nope`);
    const b = await fetch(`${base}/public/tasks/bad%20slug`);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.json()).toEqual({ error: "not found" });
  });

  it("downloads the pinned schemas", async () => {
    const res = await fetch(`${base}/public/tasks/tsk_demo/schemas.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("schemas.json");
    const body = (await res.json()) as { servers: Array<{ tools: unknown[] }> };
    expect(body.servers[0]!.tools).toHaveLength(2);
  });
});
