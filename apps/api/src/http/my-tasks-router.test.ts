import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { FakeCatalogStore } from "../domain/catalog-store.js";
import { FakeGithubAgentsRepository } from "../domain/github-agents-repository.fake.js";
import { FakeMyTasksStore } from "../domain/my-tasks-store.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { GitHubApiError, type GitHubAppApi, type TreeEntry } from "../github/app-client.js";
import { labelsFor, normalizeTaskPath } from "../github/task-layout.js";
import { issueSessionToken, requireWallet } from "./auth.js";
import { gateRows } from "./my-tasks-router.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "So11111111111111111111111111111111111111112";
const BOB = "11111111111111111111111111111111";
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const SHA_BROKEN = "3".repeat(40);

const contract = {
  schema_version: "1.0",
  task: { name: "devfellowship/split-evenly", version: "1", description: "Money split that loses the remainder." },
  metadata: { title: "Split money without losing a cent", tags: { tools: ["vitest"], concepts: ["money-math"] } },
  instruction: "instruction.md",
  environment: { dir: "environment" },
  tests: { public: "tests/public", hidden: "tests/hidden" },
  solution: { patch: "solution/solution.patch" },
  editable_paths: ["src/**"],
  protected_paths: ["tests/**", "package.json"],
  verifier: { cmd: ["npx", "vitest", "run", "{tests}", "--reporter=json", "--outputFile={report}"], timeout_sec: 60 },
  agent: { timeout_sec: 300 },
  est_minutes: 2,
};

const blob = (path: string, sha: string, size = 10): TreeEntry => ({ path, type: "blob", mode: "100644", sha, size });

/** In-memory GitHub: installation 7 on alice/tasks (public) and alice/sealed (private). */
class FakeGitHub implements GitHubAppApi {
  readonly slug = "tma-test";
  installs = new Map([
    ["alice/tasks", 7],
    ["alice/sealed", 7],
  ]);
  blobs = new Map<string, Buffer>([["task-json", Buffer.from(JSON.stringify(contract))]]);
  trees = new Map<string, TreeEntry[]>([
    [
      SHA1,
      [
        blob("task.json", "task-json"),
        blob("instruction.md", "x"),
        blob("environment/package.json", "x"),
        blob("environment/src/money.ts", "x"),
        blob("tests/public/money.test.ts", "x"),
        blob("tests/hidden/money.test.ts", "x"),
        blob("solution/solution.patch", "x"),
      ],
    ],
    [SHA2, []],
    [SHA_BROKEN, [blob("task.json", "task-json"), blob("instruction.md", "x"), blob("environment/package.json", "x")]],
  ]);
  async getInstallationAccount() {
    return { login: "alice" };
  }
  async userCanAccessInstallation() {
    return true;
  }
  async getRepoInstallationId(fullName: string) {
    return this.installs.get(fullName) ?? null;
  }
  async listInstallationRepos() {
    return [];
  }
  async resolveHead(_i: number, _r: string, ref?: string) {
    if (!ref || ref === "main") return SHA1;
    if (ref === "next") return SHA2;
    const hit = [SHA1, SHA2, SHA_BROKEN].find((s) => s.startsWith(ref));
    if (hit) return hit;
    throw new GitHubApiError("no commit", 422);
  }
  async getRepo(_i: number, fullName: string) {
    return { defaultBranch: "main", private: fullName === "alice/sealed" };
  }
  async listBranches() {
    return [];
  }
  async listCommits() {
    return [];
  }
  async listTree(_i: number, _r: string, sha: string) {
    return { entries: this.trees.get(sha) ?? [], truncated: false };
  }
  async readBlob(_i: number, _r: string, sha: string) {
    const b = this.blobs.get(sha);
    if (!b) throw new Error(`no blob ${sha}`);
    return b;
  }
}

let server: Server;
let base: string;
let store: FakeMyTasksStore;
let catalog: FakeCatalogStore;

const auth = (wallet: string) => ({ Authorization: `Bearer ${issueSessionToken(wallet).token}`, "Content-Type": "application/json" });
const call = async (method: string, path: string, wallet?: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: wallet ? auth(wallet) : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

beforeEach(async () => {
  store = new FakeMyTasksStore();
  catalog = new FakeCatalogStore();
  catalog.tags = [
    { id: "vitest", name: "Vitest", kind: "tool", sort: 1 },
    { id: "money-math", name: "Money math", kind: "concept", sort: 1 },
  ];
  const installations = new FakeGithubAgentsRepository();
  await installations.bindInstallation({ installationId: 7, ownerWallet: ALICE, accountLogin: "alice" });
  const gh = new FakeGitHub();
  const app = createApp(new FakeRepository(), {
    catalog,
    myTasks: { store, catalog, github: () => gh, installations, requireWallet },
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => server.close());

const create = (wallet = ALICE, extra: Record<string, unknown> = {}) =>
  call("POST", "/tasks", wallet, { repoFullName: "alice/tasks", branch: "main", commitSha: SHA1, ...extra });

describe("My tasks API (U19)", () => {
  it("creates a draft task + version 1 pinned to the commit; a public repo is open tests and unranked", async () => {
    const { status, body } = await create();
    expect(status).toBe(201);
    expect(body.task).toMatchObject({ kind: "user", visibility: "private", status: "draft", name: "Split money without losing a cent", runnable: false, ranked: false });
    expect(body.task.tags).toEqual(["vitest", "money-math"]);
    expect(body.version.github).toMatchObject({ repo: "alice/tasks", branch: "main", commitSha: SHA1, path: "." });
    expect(body.version.labels).toEqual(["open-tests"]);
    expect(body.version).toMatchObject({ ranked: false, unrankedReason: "open-tests", repoPrivate: false });
    expect(body.version.testsVisibility).toBe("open");
    expect(body.layout.ok).toBe(true);
    // U28: the API reads the tool environment from task_versions.contract only: the whole validated task.json is stored.
    expect(store.versions[0]!.contract).toMatchObject({ schema_version: "1.0", environment: { dir: "environment" }, verifier: { timeout_sec: 60 } });
    expect(body.layout.entries.map((e: { key: string }) => e.key)).toEqual(["taskJson", "instruction", "environment", "testsPublic", "testsHidden", "solution"]);
  });

  it("a private repo gives sealed tests and a ranked task (Q7)", async () => {
    const { body } = await call("POST", "/tasks", ALICE, { repoFullName: "alice/sealed", commitSha: SHA1 });
    expect(body.version.labels).toEqual(["sealed-tests"]);
    expect(body.version).toMatchObject({ ranked: true, unrankedReason: null, repoPrivate: true });
    expect(body.task.ranked).toBe(true);
  });

  it("refuses a layout with missing entries (422) and a repo not connected to the wallet (404)", async () => {
    const broken = await create(ALICE, { commitSha: SHA_BROKEN });
    expect(broken.status).toBe(422);
    expect(broken.body.layout.errorCode).toBe("missing_entries");
    expect(broken.body.layout.entries.filter((e: { present: boolean }) => !e.present).map((e: { key: string }) => e.key)).toEqual(["testsPublic", "testsHidden", "solution"]);
    expect((await create(ALICE, { commitSha: SHA2 })).body.layout.errorCode).toBe("no_task_json");
    expect((await create(BOB)).status).toBe(404);
    expect((await call("POST", "/tasks", ALICE, { repoFullName: "bob/other" })).status).toBe(404);
  });

  it("dry run: POST /tasks/layout returns the pin and the layout, and stores nothing", async () => {
    const { status, body } = await call("POST", "/tasks/layout", ALICE, { repoFullName: "alice/tasks", branch: "main" });
    expect(status).toBe(200);
    expect(body.pin).toMatchObject({ commitSha: SHA1, shortSha: SHA1.slice(0, 7), testsVisibility: "open" });
    expect(store.tasks).toHaveLength(0);
  });

  it("another wallet gets 404 on the task, its versions and its validation", async () => {
    const { body } = await create();
    const id = body.task.id;
    expect((await call("GET", `/tasks/${id}`, ALICE)).status).toBe(200);
    expect((await call("GET", `/tasks/${id}`, BOB)).status).toBe(404);
    expect((await call("GET", `/tasks/${id}`)).status).toBe(404);
    expect((await call("GET", `/tasks/${id}/versions`, BOB)).status).toBe(404);
    expect((await call("POST", `/tasks/${id}/versions/1/validate`, BOB)).status).toBe(404);
    expect((await call("PATCH", `/tasks/${id}`, BOB, { name: "x" })).status).toBe(404);
    expect((await call("DELETE", `/tasks/${id}`, BOB)).status).toBe(404);
  });

  it("a new pinned commit is a new version; edits never mutate a version", async () => {
    const { body } = await create();
    const id = body.task.id;
    const v2 = await call("POST", `/tasks/${id}/versions`, ALICE, { commitSha: SHA1.slice(0, 7) });
    expect(v2.status).toBe(409); // same commit as version 1
    store.versions[0]!.runnable = true;
    const patched = await call("PATCH", `/tasks/${id}`, ALICE, { name: "Split evenly", tags: ["money-math"] });
    expect(patched.status).toBe(200);
    expect(patched.body.task).toMatchObject({ name: "Split evenly", tags: ["money-math"] });
    expect(patched.body.task.versions[0].contract.task.name).toBe("devfellowship/split-evenly");
    expect((await call("PATCH", `/tasks/${id}`, ALICE, { tags: ["nope"] })).status).toBe(400);
  });

  it("validate queues one gate job per version; status reads the gate rows; DELETE is soft", async () => {
    const { body } = await create();
    const id = body.task.id;
    const q = await call("POST", `/tasks/${id}/versions/1/validate`, ALICE);
    expect(q.status).toBe(202);
    expect(q.body).toMatchObject({ created: true, version: 1, validation: { status: "queued", repeats: 3 } });
    const again = await call("POST", `/tasks/${id}/validate`, ALICE);
    expect(again.body).toMatchObject({ created: false, validationId: q.body.validationId });
    expect((await call("GET", `/tasks/${id}`, ALICE)).body.task.status).toBe("validating");
    expect((await call("POST", `/tasks/${id}/versions`, ALICE, { branch: "main" })).status).toBe(409);

    // The runner writes the result (simulated).
    const v = store.validations[0]!;
    v.status = "ready";
    v.result = {
      status: "ready",
      checks: {
        contract: { ok: true, detail: "devfellowship/split-evenly@1" },
        baseline_hidden_fails: { ok: true, detail: "FAIL as expected: 3 of 3 hidden cases fail", hidden_total: 3, hidden_failed: 3 },
        solution_passes: { ok: true, detail: "3 / 3 hidden PASS", public: "1/1", hidden: "3/3", scope_allowed: true },
        repeatable: { ok: true, detail: "3 / 3 same result", runs: 3, identical: true },
        verifier_time: { ok: true, detail: "2 s (limit 60 s)", max_ms: 2150, budget_ms: 60000 },
      },
    };
    const status = await call("GET", `/tasks/${id}/versions/1/validation`, ALICE);
    expect(status.body.validation.rows.map((r: { label: string; value: string }) => [r.label, r.value])).toEqual([
      ["Baseline hidden tests", "FAIL as expected ✓"],
      ["Solution", "3 / 3 PASS"],
      ["Repeatability", "3 / 3 same result"],
      ["Verifier time", "2 s"],
    ]);
    expect((await call("GET", `/tasks/${id}/validations/${v.id}`, BOB)).status).toBe(404);

    expect((await call("DELETE", `/tasks/${id}`, ALICE)).body).toEqual({ id, deleted: true });
    expect((await call("GET", `/tasks/${id}/versions`, ALICE)).status).toBe(404);
    expect(store.tasks[0]!.deletedAt).not.toBeNull();
  });

  it("invalid gate rows name the reason, never a test", () => {
    const rows = gateRows({
      checks: {
        contract: { ok: true, detail: "x@1" },
        baseline_hidden_fails: { ok: false, detail: "all 3 hidden cases already pass on the baseline" },
        solution_passes: { ok: true, detail: "", hidden: "3/3" },
        repeatable: { ok: true, detail: "3 / 3 same result" },
        verifier_time: { ok: true, detail: "", max_ms: 900 },
      },
    })!;
    expect(rows[0]).toMatchObject({ label: "Baseline hidden tests", ok: false, value: "all 3 hidden cases already pass on the baseline" });
    expect(rows[3]!.value).toBe("1 s");
  });

  it("path and labels helpers", () => {
    expect(normalizeTaskPath(undefined)).toBe(".");
    expect(normalizeTaskPath("/tasks/split/")).toBe("tasks/split");
    expect(() => normalizeTaskPath("../x")).toThrow();
    expect(labelsFor(true)).toEqual(["sealed-tests"]);
  });
});
