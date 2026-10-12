import { createVerify, generateKeyPairSync } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { FakeGithubAgentsRepository } from "../domain/github-agents-repository.fake.js";
import { FakeRepository } from "../domain/repository.fake.js";
import { rethrowMissingSchema } from "../domain/github-agents-repository.pg.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { AGENT_FILES_MAX_BYTES, findAgentCandidates, normalizeAgentPath, selectAgentFiles } from "../github/agent-files.js";
import { GitHubConfigError, signAppJwt, type GitHubAppApi, type InstallationRepo, type TreeEntry } from "../github/app-client.js";
import { signInstallState, verifyInstallState } from "../github/state.js";
import { issueSessionToken, requireWallet } from "./auth.js";

process.env.ITERA_SESSION_SECRET = "test-session-secret";

const ALICE = "So11111111111111111111111111111111111111112";
const BOB = "11111111111111111111111111111111";
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);

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
  async resolveHead() {
    return this.head;
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
