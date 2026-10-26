import { createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { FakeGithubAgentsRepository } from "../domain/github-agents-repository.fake.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { rethrowMissingSchema } from "../domain/github-agents-repository.pg.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { AGENT_FILES_MAX_BYTES, findAgentCandidates, normalizeAgentPath, selectAgentFiles } from "../github/agent-files.js";
import { GitHubApiError, GitHubConfigError, signAppJwt, type GitHubAppApi, type InstallationRepo, type TreeEntry } from "../github/app-client.js";
import { signInstallState, verifyInstallState, verifyInstallStateFor } from "../github/state.js";
import { isValidBranchName, slugify } from "./github-router.js";
import { AGENT_MODELS } from "../github/models.js";
import { formatBytes, summarizeAgentFiles } from "../github/agent-files.js";
import { issueSessionToken, requireWallet } from "./auth.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "So11111111111111111111111111111111111111112";
const BOB = "11111111111111111111111111111111";
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA3 = "9".repeat(40);
const VALID_TASK = {
  schema_version: "1.0",
  task: { name: "devfellowship/split-evenly", version: "1", description: "Money split." },
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

/** In-memory GitHub: one installation (42) of the App on alice-org/agents. */
class FakeGitHub implements GitHubAppApi {
  readonly slug = "itera-agents-test";
  head = SHA1;
  validCodes = new Map<string, number[]>([["good-code", [42]]]);
  repoInstallations = new Map<string, number>([["alice-org/agents", 42]]);
  repos = new Map<number, InstallationRepo[]>([[42, [{ fullName: "alice-org/agents", private: true, defaultBranch: "main" }]]]);
  blobs = new Map<string, Buffer>([
    ["blob-agents", Buffer.from("# Agent\nBe careful.\n")],
    ["blob-claude", Buffer.from("# CLAUDE\n")],
    ["blob-skill", Buffer.from("skill body")],
    ["blob-readme", Buffer.from("not an agent file")],
    ["blob-sub-agents", Buffer.from("# sub agent")],
    ["task-ok", Buffer.from(JSON.stringify(VALID_TASK))],
    ["task-bad", Buffer.from(JSON.stringify({ schema_version: "1.0", task: { name: "x/bad", version: "1" } }))],
    ["task-garbage", Buffer.from("{nope")],
  ]);
  trees = new Map<string, TreeEntry[]>([
    [
      SHA1,
      [
        { path: "AGENTS.md", type: "blob", mode: "100644", sha: "blob-agents", size: 21 },
        { path: "CLAUDE.md", type: "blob", mode: "100644", sha: "blob-claude", size: 9 },
        { path: "skills", type: "tree", mode: "040000", sha: "t1" },
        { path: "skills/fix/SKILL.md", type: "blob", mode: "100644", sha: "blob-skill", size: 10 },
        { path: "skills/link.md", type: "blob", mode: "120000", sha: "blob-skill", size: 10 },
        { path: "README.md", type: "blob", mode: "100644", sha: "blob-readme", size: 17 },
        { path: "agents/reviewer/AGENTS.md", type: "blob", mode: "100644", sha: "blob-sub-agents", size: 11 },
      ],
    ],
    [SHA2, [{ path: "AGENTS.md", type: "blob", mode: "100644", sha: "blob-sub-agents", size: 11 }]],
    [
      SHA3,
      [
        { path: "tasks/split-evenly/task.json", type: "blob", mode: "100644", sha: "task-ok", size: 300 },
        { path: "tasks/split-evenly/environment/task.json", type: "blob", mode: "100644", sha: "task-ok", size: 300 },
        { path: "tasks/zz-bad/task.json", type: "blob", mode: "100644", sha: "task-bad", size: 80 },
        { path: "tasks/zz-garbage/task.json", type: "blob", mode: "100644", sha: "task-garbage", size: 5 },
        { path: "tasks/other/readme.md", type: "blob", mode: "100644", sha: "blob-readme", size: 17 },
        { path: "node_modules/pkg/task.json", type: "blob", mode: "100644", sha: "task-ok", size: 300 },
      ],
    ],
  ]);

  async getInstallationAccount(id: number) {
    return id === 42 ? { login: "alice-org" } : null;
  }
  async userCanAccessInstallation(code: string, id: number) {
    return this.validCodes.get(code)?.includes(id) ?? false;
  }
  async getRepoInstallationId(fullName: string) {
    return this.repoInstallations.get(fullName) ?? null;
  }
  async listInstallationRepos(id: number) {
    return this.repos.get(id) ?? [];
  }
  /** main follows `head`; dev is pinned at SHA2; a hex prefix of a known commit resolves to it. */
  async resolveHead(_i: number, _r: string, ref?: string) {
    if (!ref || ref === "main") return this.head;
    if (ref === "dev") return SHA2;
    if (ref === "tasks") return SHA3;
    const hit = [SHA1, SHA2, SHA3].find((sha) => /^[0-9a-f]{7,40}$/.test(ref) && sha.startsWith(ref));
    if (hit) return hit;
    throw new GitHubApiError(`no commit ${ref}`, 404);
  }
  async getRepo() {
    return { defaultBranch: "main", private: true };
  }
  async listBranches() {
    return [
      { name: "dev", headSha: SHA2 },
      { name: "main", headSha: this.head },
    ];
  }
  commitCalls: { branch: string; limit: number }[] = [];
  async listCommits(_i: number, _r: string, branch: string, limit: number) {
    this.commitCalls.push({ branch, limit });
    if (branch !== "main" && branch !== "dev") throw new GitHubApiError("no branch", 404);
    const all = [
      { sha: SHA2, message: "feat: second", date: "2026-10-12T10:00:00Z", authorName: "Alice" },
      { sha: SHA1, message: "feat: first", date: "2026-10-11T10:00:00Z", authorName: "Alice" },
    ];
    return (branch === "dev" ? all : all.slice(1)).slice(0, limit);
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
let baseUrl: string;
let ghRepo: FakeGithubAgentsRepository;
let gh: FakeGitHub;
let githubConfigured: boolean;

const auth = (wallet: string) => ({ Authorization: `Bearer ${issueSessionToken(wallet).token}` });

async function call(method: string, path: string, opts: { wallet?: string; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(opts.wallet ? auth(opts.wallet) : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function connectAlice() {
  const state = signInstallState(ALICE, "test-session-secret");
  return call("GET", `/github/callback?installation_id=42&setup_action=install&code=good-code&state=${encodeURIComponent(state)}`);
}

beforeEach(async () => {
  ghRepo = new FakeGithubAgentsRepository();
  gh = new FakeGitHub();
  githubConfigured = true;
  server = createApp(new FakeRepository(), {
    github: {
    repo: ghRepo,
    github: () => {
      if (!githubConfigured) throw new GitHubConfigError("not configured");
      return gh;
    },
    requireWallet,
    stateSecret: () => "test-session-secret",
    },
  }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("GET /models", () => {
  it("is public and lists the allow-list", async () => {
    const { status, body } = await call("GET", "/models");
    expect(status).toBe(200);
    expect(body.models.map((m: { id: string }) => m.id)).toContain(body.default);
  });
});

describe("install flow", () => {
  it("install-url needs a wallet and carries a state that verifies to that wallet", async () => {
    expect((await call("GET", "/github/install-url")).status).toBe(401);
    const { status, body } = await call("GET", "/github/install-url", { wallet: ALICE });
    expect(status).toBe(200);
    expect(body.url).toMatch(/^https:\/\/github\.com\/apps\/itera-agents-test\/installations\/new\?state=/);
    expect(verifyInstallState(body.state, "test-session-secret")).toBe(ALICE);
  });

  it("answers 503 when the GitHub App is not configured", async () => {
    githubConfigured = false;
    expect((await call("GET", "/github/install-url", { wallet: ALICE })).status).toBe(503);
  });

  it("callback binds the installation to the wallet in the state", async () => {
    const { status, body } = await connectAlice();
    expect(status).toBe(200);
    expect(body).toMatchObject({ installationId: 42, accountLogin: "alice-org", ownerWallet: ALICE });
    expect(await ghRepo.getInstallation(42)).toMatchObject({ ownerWallet: ALICE });
  });

  it("callback refuses a forged state, a missing code, and a code that cannot see the installation", async () => {
    expect((await call("GET", "/github/callback?installation_id=42&code=good-code&state=forged.sig")).status).toBe(400);
    const state = encodeURIComponent(signInstallState(ALICE, "test-session-secret"));
    expect((await call("GET", `/github/callback?installation_id=42&state=${state}`)).status).toBe(400);
    expect((await call("GET", `/github/callback?installation_id=42&code=bad&state=${state}`)).status).toBe(403);
    expect(ghRepo.installations).toHaveLength(0);
  });

  it("callback accepts a session token when GitHub drops the state", async () => {
    const { status, body } = await call("GET", "/github/callback?installation_id=42&code=good-code", { wallet: ALICE });
    expect(status).toBe(200);
    expect(body.ownerWallet).toBe(ALICE);
  });

  it("callback refuses a state minted for another principal when the caller sends a session", async () => {
    const state = encodeURIComponent(signInstallState(ALICE, "test-session-secret"));
    const asBob = await call("GET", `/github/callback?installation_id=42&code=good-code&state=${state}`, { wallet: BOB });
    expect(asBob.status).toBe(403);
    expect(ghRepo.installations).toHaveLength(0);
    // The same state with Alice's own session passes.
    expect((await call("GET", `/github/callback?installation_id=42&code=good-code&state=${state}`, { wallet: ALICE })).status).toBe(200);
  });

  it("binds the state to a dfl principal too: A's state fails for B, B's own session works", async () => {
    const a = `dfl:${randomUUID()}`;
    const b = `dfl:${randomUUID()}`;
    const dflAuth = (id: string) => ({ Authorization: `Bearer ${issueSessionToken(id, Date.now(), "dfl").token}` });
    const stateA = encodeURIComponent(signInstallState(a, "test-session-secret"));
    const url = `${baseUrl}/github/callback?installation_id=42&code=good-code&state=${stateA}`;
    expect((await fetch(url, { headers: dflAuth(b) })).status).toBe(403);
    expect(ghRepo.installations).toHaveLength(0);
    expect(verifyInstallStateFor(decodeURIComponent(stateA), a, "test-session-secret")).toBe(true);
    expect(verifyInstallStateFor(decodeURIComponent(stateA), b, "test-session-secret")).toBe(false);
    const ok = await fetch(url, { headers: dflAuth(a) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ownerWallet).toBe(a);
  });

  it("first bind wins: another wallet cannot take over an installation", async () => {
    await connectAlice();
    gh.validCodes.set("bob-code", [42]);
    const state = encodeURIComponent(signInstallState(BOB, "test-session-secret"));
    expect((await call("GET", `/github/callback?installation_id=42&code=bob-code&state=${state}`)).status).toBe(409);
    expect((await ghRepo.getInstallation(42))?.ownerWallet).toBe(ALICE);
  });
});

describe("repos and agents", () => {
  it("lists repos only for the owning wallet", async () => {
    await connectAlice();
    expect((await call("GET", "/github/repos", { wallet: ALICE })).body.repos).toEqual([
      { installationId: 42, accountLogin: "alice-org", fullName: "alice-org/agents", private: true, defaultBranch: "main" },
    ]);
    expect((await call("GET", "/github/repos", { wallet: BOB })).body.repos).toEqual([]);
  });

  it("finds agent candidates; another wallet gets 404", async () => {
    await connectAlice();
    const { status, body } = await call("GET", "/github/repos/alice-org/agents/agent-candidates", { wallet: ALICE });
    expect(status).toBe(200);
    expect(body.commitSha).toBe(SHA1);
    expect(body.candidates).toEqual([
      { path: ".", hasAgentsMd: true, hasClaudeMd: true, hasSkills: true },
      { path: "agents/reviewer", hasAgentsMd: true, hasClaudeMd: false, hasSkills: false },
    ]);
    expect((await call("GET", "/github/repos/alice-org/agents/agent-candidates", { wallet: BOB })).status).toBe(404);
  });

  it("registers an agent pinned at HEAD with AGENTS.md, CLAUDE.md and skills only", async () => {
    await connectAlice();
    const { status, body } = await call("POST", "/agents", {
      wallet: ALICE,
      body: { repoFullName: "alice-org/agents", agentPath: ".", model: "qwen/qwen3-coder", name: "fixer" },
    });
    expect(status).toBe(201);
    expect(body.agent).toMatchObject({ name: "fixer", ownerWallet: ALICE, repoFullName: "alice-org/agents", agentPath: ".", model: "qwen/qwen3-coder" });
    expect(body.agent.latestVersion).toMatchObject({ commitSha: SHA1, fileCount: 3 });
    expect(body.version.files.map((f: { path: string }) => f.path)).toEqual(["AGENTS.md", "CLAUDE.md", "skills/fix/SKILL.md"]);
    const stored = ghRepo.versions[0]!;
    expect(stored.files[0]).toMatchObject({ path: "AGENTS.md", encoding: "utf-8", content: "# Agent\nBe careful.\n" });

    const mine = await call("GET", "/agents", { wallet: ALICE });
    expect(mine.body.agents).toHaveLength(1);
    expect((await call("GET", "/agents", { wallet: BOB })).body.agents).toEqual([]);
    expect((await call("GET", `/agents/${body.agent.id}`, { wallet: BOB })).status).toBe(404);
  });

  it("registers a sub-path agent with paths relative to it", async () => {
    await connectAlice();
    const { status, body } = await call("POST", "/agents", {
      wallet: ALICE,
      body: { repoFullName: "alice-org/agents", agentPath: "agents/reviewer/", model: "anthropic/claude-haiku-4.5" },
    });
    expect(status).toBe(201);
    expect(body.agent).toMatchObject({ name: "alice-org/agents/agents/reviewer", agentPath: "agents/reviewer" });
    expect(body.version.files.map((f: { path: string }) => f.path)).toEqual(["AGENTS.md"]);
  });

  it("rejects a model outside the allow-list, a path traversal, a dir without agent files, and an unconnected repo", async () => {
    await connectAlice();
    const base = { repoFullName: "alice-org/agents", agentPath: "." };
    expect((await call("POST", "/agents", { wallet: ALICE, body: { ...base, model: "openai/gpt-4" } })).status).toBe(400);
    expect((await call("POST", "/agents", { wallet: ALICE, body: { ...base, agentPath: "../x" } })).status).toBe(400);
    expect((await call("POST", "/agents", { wallet: ALICE, body: { ...base, agentPath: "skills" } })).status).toBe(422);
    expect((await call("POST", "/agents", { wallet: ALICE, body: { ...base, repoFullName: "other/repo" } })).status).toBe(404);
    expect((await call("POST", "/agents", { wallet: BOB, body: base })).status).toBe(404);
    expect((await call("POST", "/agents", { body: base })).status).toBe(401);
  });

  it("refresh adds a version at the new HEAD and is idempotent at an unchanged HEAD", async () => {
    await connectAlice();
    const created = await call("POST", "/agents", { wallet: ALICE, body: { repoFullName: "alice-org/agents" } });
    const id = created.body.agent.id;
    const same = await call("POST", `/agents/${id}/refresh`, { wallet: ALICE });
    expect(same.body.changed).toBe(false);
    expect(ghRepo.versions).toHaveLength(1);
    gh.head = SHA2;
    const moved = await call("POST", `/agents/${id}/refresh`, { wallet: ALICE });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ changed: true, version: { commitSha: SHA2 } });
    expect(moved.body.agent.latestVersion.commitSha).toBe(SHA2);
    expect(ghRepo.versions).toHaveLength(2);
    expect((await call("POST", `/agents/${id}/refresh`, { wallet: BOB })).status).toBe(404);
  });
});

describe("0002 schema guard", () => {
  it("answers 503 naming the migration when the 0002 tables are missing, not 500", async () => {
    ghRepo.schemaReady = false;
    for (const [method, path] of [
      ["GET", "/agents"],
      ["GET", "/github/repos"],
      ["GET", "/github/installations"],
      ["POST", "/agents"],
    ] as const) {
      const { status, body } = await call(method, path, { wallet: ALICE, body: method === "POST" ? { repoFullName: "alice-org/agents" } : undefined });
      expect(status, `${method} ${path}`).toBe(503);
      expect(body.error).toContain("db/migrations/0002_github_agents.sql");
    }
    const cb = await connectAlice();
    expect(cb.status).toBe(503);
    // Routes that need no 0002 table keep working.
    expect((await call("GET", "/models")).status).toBe(200);
    expect((await call("GET", "/github/install-url", { wallet: ALICE })).status).toBe(200);
  });

  it("maps Postgres 42P01 / 42703 to SchemaNotReadyError and leaves other errors alone", () => {
    for (const code of ["42P01", "42703"]) {
      expect(() => rethrowMissingSchema(Object.assign(new Error("x"), { code }))).toThrow(SchemaNotReadyError);
    }
    const other = Object.assign(new Error("boom"), { code: "23505" });
    expect(() => rethrowMissingSchema(other)).toThrow(other);
  });
});

describe("agent-files", () => {
  it("normalizes agent paths", () => {
    expect(normalizeAgentPath(undefined)).toBe(".");
    expect(normalizeAgentPath("/")).toBe(".");
    expect(normalizeAgentPath("/a/b/")).toBe("a/b");
    expect(() => normalizeAgentPath("a/../b")).toThrow();
    expect(() => normalizeAgentPath("a//b")).toThrow();
  });

  it("refuses (never truncates) a snapshot above the cap", () => {
    const entries: TreeEntry[] = [
      { path: "AGENTS.md", type: "blob", mode: "100644", sha: "x", size: 10 },
      { path: "skills/big.bin", type: "blob", mode: "100644", sha: "y", size: AGENT_FILES_MAX_BYTES },
    ];
    expect(selectAgentFiles(entries, ".")).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("does not treat a nested dir's skills as the root agent's", () => {
    const entries: TreeEntry[] = [{ path: "x/skills/a.md", type: "blob", mode: "100644", sha: "s", size: 1 }];
    expect(findAgentCandidates(entries)).toEqual([]);
  });
});

describe("state and app JWT", () => {
  it("rejects an expired or tampered state", () => {
    const s = signInstallState(ALICE, "k", 1000);
    expect(verifyInstallState(s, "k", 1001)).toBe(ALICE);
    expect(verifyInstallState(s, "k", 1000 + 31 * 60)).toBeNull();
    expect(verifyInstallState(s, "other", 1001)).toBeNull();
    expect(verifyInstallState(`${s}x`, "k", 1001)).toBeNull();
  });

  it("signs an RS256 app JWT that verifies with the public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = signAppJwt("123", privateKey.export({ type: "pkcs1", format: "pem" }).toString(), 10_000);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: 9_940, exp: 10_540, iss: "123" });
  });
});

describe("branches, commits, validate and the pinned POST /agents (U8)", () => {
  it("lists branches with the default first, and 404 for another wallet", async () => {
    await connectAlice();
    const { status, body } = await call("GET", "/github/repos/alice-org/agents/branches", { wallet: ALICE });
    expect(status).toBe(200);
    expect(body).toMatchObject({ repoFullName: "alice-org/agents", defaultBranch: "main" });
    expect(body.branches).toEqual([
      { name: "main", headSha: SHA1, shortSha: SHA1.slice(0, 7), isDefault: true },
      { name: "dev", headSha: SHA2, shortSha: SHA2.slice(0, 7), isDefault: false },
    ]);
    expect((await call("GET", "/github/repos/alice-org/agents/branches", { wallet: BOB })).status).toBe(404);
    expect((await call("GET", "/github/repos/alice-org/agents/branches")).status).toBe(401);
  });

  it("lists the latest commits of a branch in one call (default limit 20, HEAD first)", async () => {
    await connectAlice();
    const { status, body } = await call("GET", "/github/repos/alice-org/agents/commits?branch=dev", { wallet: ALICE });
    expect(status).toBe(200);
    expect(body).toMatchObject({ branch: "dev", headSha: SHA2 });
    expect(body.commits).toEqual([
      { sha: SHA2, shortSha: SHA2.slice(0, 7), message: "feat: second", date: "2026-10-12T10:00:00Z", authorName: "Alice", isHead: true },
      { sha: SHA1, shortSha: SHA1.slice(0, 7), message: "feat: first", date: "2026-10-11T10:00:00Z", authorName: "Alice", isHead: false },
    ]);
    expect(gh.commitCalls).toEqual([{ branch: "dev", limit: 20 }]);
    const def = await call("GET", "/github/repos/alice-org/agents/commits?limit=1", { wallet: ALICE });
    expect(def.body).toMatchObject({ branch: "main", headSha: SHA1 });
    expect(gh.commitCalls.at(-1)).toEqual({ branch: "main", limit: 1 });
    expect((await call("GET", "/github/repos/alice-org/agents/commits?limit=0", { wallet: ALICE })).status).toBe(400);
    expect((await call("GET", "/github/repos/alice-org/agents/commits?limit=101", { wallet: ALICE })).status).toBe(400);
    expect((await call("GET", "/github/repos/alice-org/agents/commits?branch=a..b", { wallet: ALICE })).status).toBe(400);
    expect((await call("GET", "/github/repos/alice-org/agents/commits?branch=nope", { wallet: ALICE })).status).toBe(404);
    expect((await call("GET", "/github/repos/alice-org/agents/commits", { wallet: BOB })).status).toBe(404);
  });

  it("agent-candidates reads a branch or a commit with ?ref=", async () => {
    await connectAlice();
    const dev = await call("GET", "/github/repos/alice-org/agents/agent-candidates?ref=dev", { wallet: ALICE });
    expect(dev.body.commitSha).toBe(SHA2);
    expect(dev.body.candidates).toEqual([{ path: ".", hasAgentsMd: true, hasClaudeMd: false, hasSkills: false }]);
    const bySha = await call("GET", `/github/repos/alice-org/agents/agent-candidates?ref=${SHA1.slice(0, 7)}`, { wallet: ALICE });
    expect(bySha.body.commitSha).toBe(SHA1);
  });

  it("task-candidates lists the folders with a task.json, with name, slug and the schema verdict (U34)", async () => {
    await connectAlice();
    const { status, body } = await call("GET", "/github/repos/alice-org/agents/task-candidates?ref=tasks", { wallet: ALICE });
    expect(status).toBe(200);
    expect(body).toMatchObject({ commitSha: SHA3, truncatedTree: false, capped: false });
    // The task.json under environment/ (inside a candidate) and under node_modules are not candidates.
    expect(body.candidates.map((c: { path: string }) => c.path)).toEqual(["tasks/split-evenly", "tasks/zz-bad", "tasks/zz-garbage"]);
    expect(body.candidates[0]).toEqual({ path: "tasks/split-evenly", name: "devfellowship/split-evenly", slug: "split-evenly", title: null, valid: true, error: null });
    expect(body.candidates[1]).toMatchObject({ path: "tasks/zz-bad", name: "x/bad", slug: "bad", valid: false });
    expect(typeof body.candidates[1].error).toBe("string");
    expect(body.candidates[2]).toMatchObject({ path: "tasks/zz-garbage", name: null, valid: false, error: "task.json is not valid JSON" });
    // A repo without any task.json answers an empty list; another wallet gets 404.
    expect((await call("GET", "/github/repos/alice-org/agents/task-candidates", { wallet: ALICE })).body.candidates).toEqual([]);
    expect((await call("GET", "/github/repos/alice-org/agents/task-candidates?ref=tasks", { wallet: BOB })).status).toBe(404);
    expect((await call("GET", "/github/repos/alice-org/agents/task-candidates?ref=tasks")).status).toBe(401);
  });

  it("validate: ok with the file list and summary at a SHA; a danger error for a path without AGENTS.md or CLAUDE.md", async () => {
    await connectAlice();
    const ok = await call("POST", "/agents/validate", { wallet: ALICE, body: { repoFullName: "alice-org/agents", agentPath: ".", commit: SHA1 } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, commit: SHA1, shortCommit: SHA1.slice(0, 7), branch: "main", agentPath: ".", summary: "AGENTS.md + CLAUDE.md + 1 skill · 40 B" });
    expect(ok.body.files).toEqual([
      { path: "AGENTS.md", bytes: 21 },
      { path: "CLAUDE.md", bytes: 9 },
      { path: "skills/fix/SKILL.md", bytes: 10 },
    ]);
    expect(ghRepo.agents).toHaveLength(0); // a dry run stores nothing

    const bad = await call("POST", "/agents/validate", { wallet: ALICE, body: { repoFullName: "alice-org/agents", agentPath: "skills", commit: SHA1 } });
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false, errorCode: "no_agent_file", files: [] });
    expect(bad.body.error).toMatch(/No AGENTS\.md or CLAUDE\.md in skills at aaaaaaa/);
    expect(bad.body.candidates).toEqual([".", "agents/reviewer"]);

    expect((await call("POST", "/agents/validate", { wallet: ALICE, body: { repoFullName: "alice-org/agents", commit: "zz" } })).status).toBe(400);
    expect((await call("POST", "/agents/validate", { wallet: ALICE, body: { repoFullName: "alice-org/agents", commit: "c".repeat(40) } })).status).toBe(404);
    expect((await call("POST", "/agents/validate", { wallet: BOB, body: { repoFullName: "alice-org/agents" } })).status).toBe(404);
  });

  it("POST /agents pins the given commit, stores branch/description/visibility/slug, and the pinned version is the current one", async () => {
    await connectAlice();
    gh.head = SHA2; // HEAD of main moved on; the user picks the older commit
    gh.trees.set(SHA2, gh.trees.get(SHA1)!);
    const { status, body } = await call("POST", "/agents", {
      wallet: ALICE,
      body: {
        repoFullName: "alice-org/agents",
        agentPath: ".",
        name: "Ledger Line",
        branch: "main",
        commitSha: SHA1,
        modelRelease: "qwen/qwen3-coder",
        description: "Fixes idempotency bugs.",
        visibility: "private",
      },
    });
    expect(status).toBe(201);
    expect(body.pinned).toEqual({ branch: "main", commitSha: SHA1, shortSha: SHA1.slice(0, 7) });
    expect(body.agent).toMatchObject({
      slug: "ledger-line",
      branch: "main",
      pinnedCommit: SHA1,
      description: "Fixes idempotency bugs.",
      visibility: "private",
      modelRelease: "qwen/qwen3-coder",
      status: "draft",
    });
    expect(body.agent.latestVersion.commitSha).toBe(SHA1);
    expect(body.summary).toBe("AGENTS.md + CLAUDE.md + 1 skill · 39 B"); // real bytes, not the tree sizes
    expect(body.warnings).toBeUndefined();

    // Re-pin to HEAD, then back to the older commit: the older version becomes current again.
    await call("POST", "/agents", { wallet: ALICE, body: { repoFullName: "alice-org/agents", name: "Ledger Line", branch: "main" } });
    expect((await ghRepo.getGithubAgent(body.agent.id))!.latestVersion!.commitSha).toBe(SHA2);
    await call("POST", "/agents", { wallet: ALICE, body: { repoFullName: "alice-org/agents", name: "Ledger Line", commit: SHA1.slice(0, 7) } });
    expect((await ghRepo.getGithubAgent(body.agent.id))!.latestVersion!.commitSha).toBe(SHA1);
    expect(ghRepo.versions).toHaveLength(2);
  });

  it("POST /agents without a commit pins the branch HEAD; a taken slug gets 4 hex", async () => {
    await connectAlice();
    const a = await call("POST", "/agents", { wallet: ALICE, body: { repoFullName: "alice-org/agents", name: "Fixer", branch: "dev" } });
    expect(a.body.pinned.commitSha).toBe(SHA2);
    expect(a.body.agent.slug).toBe("fixer");
    const b = await call("POST", "/agents", { wallet: ALICE, body: { repoFullName: "alice-org/agents", name: "fixer!" } });
    expect(b.body.agent.slug).toMatch(/^fixer-[0-9a-f]{4}$/);
    expect(b.body.agent.visibility).toBe("listed");
  });

  it("POST /agents rejects a long description, a bad visibility, a bad branch and an unknown commit", async () => {
    await connectAlice();
    const base = { repoFullName: "alice-org/agents" };
    expect((await call("POST", "/agents", { wallet: ALICE, body: { ...base, description: "x".repeat(91) } })).status).toBe(400);
    expect((await call("POST", "/agents", { wallet: ALICE, body: { ...base, visibility: "public" } })).status).toBe(400);
    expect((await call("POST", "/agents", { wallet: ALICE, body: { ...base, branch: "-x" } })).status).toBe(400);
    expect((await call("POST", "/agents", { wallet: ALICE, body: { ...base, commit: "d".repeat(40) } })).status).toBe(404);
    expect(ghRepo.agents).toHaveLength(0);
  });

  it("POST /agents still works before the agents columns migration and says what it did not store", async () => {
    await connectAlice();
    ghRepo.metaColumns = false;
    const { status, body } = await call("POST", "/agents", { wallet: ALICE, body: { repoFullName: "alice-org/agents", name: "x", description: "d", commit: SHA1 } });
    expect(status).toBe(201);
    expect(body.agent.latestVersion.commitSha).toBe(SHA1);
    expect(body.warnings[0]).toMatch(/description/);
  });

  it("U28: requires is a chip field — POST /agents stores it normalized, PATCH /agents/:id replaces it, GET returns it; owner only", async () => {
    await connectAlice();
    const { status, body } = await call("POST", "/agents", { wallet: ALICE, body: { repoFullName: "alice-org/agents", name: "Needs PG", requires: ["Postgres", "tool:bash"] } });
    expect(status).toBe(201);
    expect(body.agent.requires).toEqual(["mcp:postgres", "tool:bash"]);
    const id = body.agent.id;
    const p = await call("PATCH", `/agents/${id}`, { wallet: ALICE, body: { requires: ["mcp:calendar"] } });
    expect(p.status).toBe(200);
    expect(p.body.agent.requires).toEqual(["mcp:calendar"]);
    expect((await call("GET", `/agents/${id}`, { wallet: ALICE })).body.agent.requires).toEqual(["mcp:calendar"]);
    expect((await call("PATCH", `/agents/${id}`, { wallet: ALICE, body: { requires: [] } })).body.agent.requires).toEqual([]);
    expect((await call("PATCH", `/agents/${id}`, { wallet: BOB, body: { requires: [] } })).status).toBe(404);
    expect((await call("PATCH", `/agents/${id}`, { body: { requires: [] } })).status).toBe(401);
    expect((await call("PATCH", `/agents/${id}`, { wallet: ALICE, body: { requires: ["tool:webfetch"] } })).status).toBe(400);
    expect((await call("PATCH", `/agents/${id}`, { wallet: ALICE, body: { requires: "postgres" } })).status).toBe(400);
    expect((await call("PATCH", `/agents/${id}`, { wallet: ALICE, body: {} })).status).toBe(400);
    expect((await call("POST", "/agents", { wallet: ALICE, body: { repoFullName: "alice-org/agents", name: "y", requires: ["bad name"] } })).status).toBe(400);
    ghRepo.metaColumns = false;
    expect((await call("PATCH", `/agents/${id}`, { wallet: ALICE, body: { requires: [] } })).status).toBe(503);
  });

  it("L4: PATCH /agents/:id takes model_id for a GitHub agent, checked against the allow-list", async () => {
    await connectAlice();
    const { body } = await call("POST", "/agents", { wallet: ALICE, body: { repoFullName: "alice-org/agents", name: "Model swap" } });
    const id = body.agent.id;
    const other = AGENT_MODELS.find((m) => m.id !== body.agent.model)!.id;
    const p = await call("PATCH", `/agents/${id}`, { wallet: ALICE, body: { model_id: other } });
    expect(p.status).toBe(200);
    expect(p.body.agent.model).toBe(other);
    expect((await call("PATCH", `/agents/${id}`, { wallet: ALICE, body: { model_id: "acme/not-allowed" } })).status).toBe(400);
    expect((await call("PATCH", `/agents/${id}`, { wallet: ALICE, body: { model_id: 42 } })).status).toBe(400);
    expect((await call("GET", `/agents/${id}`, { wallet: ALICE })).body.agent.model).toBe(other);
  });

  it("GET /agents/:id answers 404 (not 500) for a non-uuid id", async () => {
    expect((await call("GET", "/agents/not-a-uuid", { wallet: ALICE })).status).toBe(404);
  });

  it("helpers: branch names, slugs, sizes", () => {
    expect(isValidBranchName("feature/x-1")).toBe(true);
    for (const bad of ["", "-x", "a..b", "a b", "x.lock", "a//b", "x/", "a~1", "a:b"]) expect(isValidBranchName(bad), bad).toBe(false);
    expect(slugify("Ledger Líne 2!")).toBe("ledger-line-2");
    expect(slugify("!!!")).toBeNull();
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1434)).toBe("1.4 KB");
    expect(formatBytes(41 * 1024)).toBe("41 KB");
    expect(
      summarizeAgentFiles([
        { path: "AGENTS.md", size: 1024 },
        { path: "skills/a/SKILL.md", size: 1024 },
        { path: "skills/a/ref.md", size: 1024 },
        { path: "skills/b.md", size: 1024 },
        { path: "skills/c/SKILL.md", size: 38 * 1024 },
      ]).summary,
    ).toBe("AGENTS.md + 3 skills · 42 KB");
  });
});

describe("sample repos (U37): any wallet, no install", () => {
  let sampleServer: Server;
  let sampleBase: string;
  const sampleCall = async (method: string, path: string, wallet: string, body?: unknown) => {
    const res = await fetch(`${sampleBase}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...auth(wallet) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  beforeEach(async () => {
    // alice-org/agents is the sample repo; installation 42 is bound to ALICE. BOB has no installation.
    await connectAlice();
    gh.repoInstallations.set("alice-org/private", 42);
    sampleServer = createApp(new FakeRepository(), {
      github: { repo: ghRepo, github: () => gh, requireWallet, stateSecret: () => "test-session-secret", samples: { agents: ["alice-org/agents"], tasks: [], installationId: 42 } },
    }).listen(0);
    await new Promise<void>((resolve) => sampleServer.once("listening", resolve));
    sampleBase = `http://127.0.0.1:${(sampleServer.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => sampleServer.close(() => resolve()));
  });

  it("lists the sample repos publicly", async () => {
    const res = await fetch(`${sampleBase}/github/sample-repos`);
    expect(await res.json()).toEqual({ agents: ["alice-org/agents"], tasks: [] });
  });

  it("a wallet with no installation reads branches, commits, validates and registers the sample agent; the row is its own, source sample", async () => {
    expect((await sampleCall("GET", "/github/repos/alice-org/agents/branches", BOB)).status).toBe(200);
    expect((await sampleCall("GET", "/github/repos/alice-org/agents/commits?branch=main", BOB)).body.headSha).toBe(SHA1);
    const v = await sampleCall("POST", "/agents/validate", BOB, { repoFullName: "alice-org/agents", branch: "main", agentPath: "." });
    expect(v.body).toMatchObject({ ok: true, source: "sample" });
    const created = await sampleCall("POST", "/agents", BOB, { repoFullName: "alice-org/agents", branch: "main", agentPath: ".", name: "Bob sample", source: "sample" });
    expect(created.status).toBe(201);
    expect(created.body.agent).toMatchObject({ ownerWallet: BOB, installationId: 42, source: "sample" });
    expect((await sampleCall("GET", "/agents", BOB)).body.agents.map((a: { source: string }) => a.source)).toEqual(["sample"]);
    // Refresh keeps working for the non-owner of the installation.
    expect((await sampleCall("POST", `/agents/${created.body.agent.id}/refresh`, BOB)).status).toBe(200);
  });

  it("refuses a repo outside the allow-list on the sample path (403), and keeps the normal path (404) for it", async () => {
    const asked = await sampleCall("POST", "/agents", BOB, { repoFullName: "alice-org/private", agentPath: ".", source: "sample" });
    expect(asked.status).toBe(403);
    expect((await sampleCall("GET", "/github/repos/alice-org/private/branches?source=sample", BOB)).status).toBe(403);
    expect((await sampleCall("POST", "/agents", BOB, { repoFullName: "alice-org/private", agentPath: "." })).status).toBe(404);
    // The installation owner still uses the normal path for its other repos.
    const own = await sampleCall("POST", "/agents/validate", ALICE, { repoFullName: "alice-org/private", agentPath: "." });
    expect(own.body.source).toBe("github");
  });
});
