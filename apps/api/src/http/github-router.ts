import { parseAgentRequires } from "@itera/contracts";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { requiredSecret } from "../config.js";
import { PgGithubAgentsRepository } from "../domain/github-agents-repository.pg.js";
import type { GithubAgentsRepository } from "../domain/github-agents-repository.js";
import { getPool } from "../domain/pool.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import {
  AGENT_FILES_MAX_BYTES,
  AgentPathError,
  encodeAgentFile,
  findAgentCandidates,
  normalizeAgentPath,
  selectAgentFiles,
  summarizeAgentFiles,
  type AgentFile,
} from "../github/agent-files.js";
import { GitHubApiError, GitHubAppClient, GitHubConfigError, githubAppConfigFromEnv, type GitHubAppApi } from "../github/app-client.js";
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, isAllowedModel } from "../github/models.js";
import { findTaskCandidates } from "../github/task-layout.js";
import { signInstallState, verifyInstallState, verifyInstallStateFor } from "../github/state.js";
import { isSampleRepo, repoSourceOf, sampleInstallation, sampleReposFromEnv, SampleRepoError, type RepoSource, type SampleKind, type SampleRepos } from "../github/sample-repos.js";
import { requireWallet as defaultRequireWallet } from "./auth.js";

/**
 * GitHub App agent connector (lane C, ADR-2): a user installs the read-only Itera GitHub App on the
 * repos that hold agents; Itera reads AGENTS.md / CLAUDE.md / skills/** at a pinned commit SHA.
 *
 *   GET  /models                                       public — model allow-list
 *   GET  /github/sample-repos                          public — U37: sample repos any wallet may use
 *   GET  /github/install-url                           wallet — install URL with signed state
 *   GET  /github/callback?installation_id&state&code   binds the installation to the wallet
 *   GET  /github/installations                         wallet
 *   GET  /github/repos                                 wallet — repos the App can read
 *   GET  /github/repos/:owner/:repo/branches           wallet — branches + head SHA (U8)
 *   GET  /github/repos/:owner/:repo/commits?branch=&limit=20  wallet — latest commits of a branch (U8)
 *   GET  /github/repos/:owner/:repo/agent-candidates?ref=     wallet — dirs with AGENTS.md / CLAUDE.md
 *   GET  /github/repos/:owner/:repo/task-candidates?ref=      wallet — dirs with a task.json (U34, many tasks in one repo)
 *   POST /agents/validate {repoFullName, branch?, commit?, agentPath}  wallet — dry run of POST /agents (U8)
 *   POST /agents {repoFullName, agentPath, model, name, branch?, commit?, modelRelease?, description?, visibility?}
 *                                                      wallet — snapshot at the pinned commit (default: branch HEAD)
 *   GET  /agents                                       wallet — my agents
 *   PATCH /agents/:id {requires?, model_id?}           owner  — U28 agent requires; L4 model (allow-list)
 *                                                      (a local agent: local-agents/router.ts, mounted first)
 *   GET  /agents/:id                                   owner  — agent + latest version file list
 *   POST /agents/:id/refresh                           owner  — new version at the new HEAD
 */
export interface GithubRouterDeps {
  repo: GithubAgentsRepository;
  /** Lazy: throws GitHubConfigError until GITHUB_APP_* is set; routes answer 503 then. */
  github: () => GitHubAppApi;
  requireWallet: RequestHandler;
  /** HMAC key for the install `state` (ITERA_SESSION_SECRET). */
  stateSecret: () => string;
  /** U21 model access check (models.enabled in the DB). Absent → the static allow-list. */
  isModelAllowed?: (modelId: string) => Promise<boolean>;
  /** U37: sample repos any wallet may read through the TestMyAgent installation. Absent → env defaults. */
  samples?: SampleRepos;
  /** L4: the caller's local agents, appended by GET /agents?include=local (local-agents/router.ts). */
  localAgents?: (wallet: string) => Promise<unknown[]>;
}

export function defaultGithubRouterDeps(): GithubRouterDeps {
  let client: GitHubAppClient | null = null;
  return {
    repo: new PgGithubAgentsRepository(getPool),
    github: () => (client ??= new GitHubAppClient(githubAppConfigFromEnv())),
    requireWallet: defaultRequireWallet,
    stateSecret: () => requiredSecret("ITERA_SESSION_SECRET"),
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const REPO_FULL_NAME_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const COMMIT_INPUT_RE = /^[0-9a-fA-F]{7,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RELEASE_RE = /^[A-Za-z0-9._:/-]{1,120}$/;
export const AGENT_DESCRIPTION_MAX = 90;
export const COMMITS_DEFAULT_LIMIT = 20;
export const COMMITS_MAX_LIMIT = 100;

/** A git branch name, per the parts of git-check-ref-format that matter for a URL query value. */
export function isValidBranchName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  return !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name);
}

/** "Ledger Line 2!" → "ledger-line-2" (≤ 48 chars); null when nothing usable is left. */
export function slugify(name: string): string | null {
  const s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || null;
}

type Handler = (req: Request, res: Response) => Promise<void>;

/** Maps domain errors to JSON responses; never leaks a stack or a token. */
/** U28: the `requires` chip field, normalized ("postgres" → "mcp:postgres"). 400 on a bad entry. */
function requiresOf(value: unknown): string[] {
  const r = parseAgentRequires(value);
  if (!r.ok) throw new HttpError(400, r.errors.join("; "));
  return r.value;
}

function wrap(fn: Handler): RequestHandler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        res.status(e.status).json({ error: e.message, ...e.extra });
      } else if (e instanceof SampleRepoError) {
        res.status(e.status).json({ error: e.message });
      } else if (e instanceof SchemaNotReadyError) {
        res.status(503).json({ error: e.message });
      } else if (e instanceof GitHubConfigError) {
        res.status(503).json({ error: "the TestMyAgent GitHub App is not configured on this server yet" });
      } else if (e instanceof GitHubApiError) {
        const status = e.status === 404 ? 404 : 502;
        res.status(status).json({ error: status === 404 ? "not found on GitHub" : "GitHub request failed", githubStatus: e.status });
      } else {
        console.error("github-router error", e);
        res.status(500).json({ error: "internal error" });
      }
    }
  };
}

function wallet(req: Request): string {
  if (!req.wallet) throw new HttpError(401, "a valid wallet session is required");
  return req.wallet;
}

export function createGithubRouter(deps: GithubRouterDeps): Router {
  const router = Router();
  const { repo, github, requireWallet } = deps;

  const samples = deps.samples ?? sampleReposFromEnv();

  /**
   * The installation to read `repoFullName` through.
   *  - U37 sample repos: a repo on the sample allow-list (or `source: "sample"` asked explicitly) is
   *    read through the TestMyAgent installation, whatever wallet calls. An explicit sample request
   *    for a repo outside the allow-list is refused (403).
   *  - Otherwise the installation that covers the repo must be bound to the caller's wallet. Answers
   *    404 then, so a caller cannot probe which repos other wallets connected.
   */
  async function resolveInstallation(
    walletAddr: string,
    repoFullName: string,
    opts: { kind?: SampleKind; sample?: boolean } = {},
  ): Promise<{ installationId: number; source: RepoSource }> {
    if (!REPO_FULL_NAME_RE.test(repoFullName)) throw new HttpError(400, "repoFullName must look like owner/repo");
    if (opts.sample || isSampleRepo(samples, repoFullName, opts.kind)) {
      // Allow-list first: a refused repo never reaches GitHub.
      if (!isSampleRepo(samples, repoFullName, opts.kind)) sampleInstallation(samples, repoFullName, opts.kind, null);
      const covering = await github().getRepoInstallationId(repoFullName);
      return { installationId: sampleInstallation(samples, repoFullName, opts.kind, covering), source: "sample" };
    }
    const installationId = await github().getRepoInstallationId(repoFullName);
    const inst = installationId === null ? null : await repo.getInstallation(installationId);
    if (installationId === null || !inst || inst.ownerWallet !== walletAddr) {
      throw new HttpError(404, "repo not connected: install the TestMyAgent GitHub App on it from this wallet");
    }
    return { installationId, source: "github" };
  }

  async function installationFor(walletAddr: string, repoFullName: string, opts: { kind?: SampleKind; sample?: boolean } = {}): Promise<number> {
    return (await resolveInstallation(walletAddr, repoFullName, opts)).installationId;
  }

  /** `source: "sample"` in a body or `?source=sample` in a query: the caller asks for the sample path. */
  const wantsSample = (v: unknown) => v === "sample";
  const withSource = <T extends { repoFullName: string }>(a: T & { source?: unknown }) => ({
    ...a,
    source: repoSourceOf(a.source, samples, a.repoFullName, "agent"),
  });

  /**
   * The commit an agent is pinned to: `commit` when given (short SHAs are resolved and checked to
   * exist), else the HEAD of `branch`, else the HEAD of the default branch.
   */
  async function resolveCommit(
    installationId: number,
    repoFullName: string,
    input: { branch?: unknown; commit?: unknown },
  ): Promise<{ commitSha: string; branch: string }> {
    const gh = github();
    if (input.branch !== undefined && input.branch !== null && input.branch !== "" && !isValidBranchName(input.branch)) {
      throw new HttpError(400, "branch is not a valid branch name");
    }
    if (input.commit !== undefined && input.commit !== null && input.commit !== "" && (typeof input.commit !== "string" || !COMMIT_INPUT_RE.test(input.commit))) {
      throw new HttpError(400, "commit must be a hex commit SHA (7 to 40 characters)");
    }
    const branch = typeof input.branch === "string" && input.branch ? input.branch : (await gh.getRepo(installationId, repoFullName)).defaultBranch;
    const ref = typeof input.commit === "string" && input.commit ? input.commit.toLowerCase() : branch;
    const commitSha = await gh.resolveHead(installationId, repoFullName, ref);
    if (!SHA_RE.test(commitSha)) throw new HttpError(502, "GitHub returned an invalid commit SHA");
    return { commitSha, branch };
  }

  /** Reads AGENTS.md, CLAUDE.md and skills/** under agentPath at `commitSha` (default: the repo HEAD). */
  async function snapshot(installationId: number, repoFullName: string, agentPath: string, pinned?: string): Promise<{ commitSha: string; files: AgentFile[] }> {
    const gh = github();
    const commitSha = pinned ?? (await gh.resolveHead(installationId, repoFullName));
    if (!SHA_RE.test(commitSha)) throw new HttpError(502, "GitHub returned an invalid commit SHA");
    const tree = await gh.listTree(installationId, repoFullName, commitSha);
    const picked = selectAgentFiles(tree.entries, agentPath);
    if (!picked.ok && picked.reason === "no_agent_file") {
      throw new HttpError(422, `no AGENTS.md or CLAUDE.md at ${agentPath} in ${repoFullName}@${commitSha.slice(0, 7)}`, {
        truncatedTree: tree.truncated,
      });
    }
    if (!picked.ok) {
      throw new HttpError(413, `agent files total ${picked.totalBytes} bytes, above the ${AGENT_FILES_MAX_BYTES}-byte cap`);
    }
    const files: AgentFile[] = [];
    let total = 0;
    for (const e of picked.entries) {
      const bytes = await gh.readBlob(installationId, repoFullName, e.sha);
      total += bytes.length;
      // The tree sizes were already checked; re-check real bytes so a lying tree cannot pass the cap.
      if (total > AGENT_FILES_MAX_BYTES) throw new HttpError(413, `agent files exceed the ${AGENT_FILES_MAX_BYTES}-byte cap`);
      files.push(encodeAgentFile(e.relPath, e.sha, bytes));
    }
    return { commitSha, files };
  }

  const fileSummary = (files: AgentFile[]) => files.map((f) => ({ path: f.path, size: f.size, sha: f.sha }));

  router.get("/models", (_req, res) => {
    res.json({ default: DEFAULT_AGENT_MODEL, models: AGENT_MODELS });
  });

  router.get("/github/sample-repos", (_req, res) => {
    res.json({ agents: samples.agents, tasks: samples.tasks });
  });

  router.get(
    "/github/install-url",
    requireWallet,
    wrap(async (req, res) => {
      const gh = github();
      const state = signInstallState(wallet(req), deps.stateSecret());
      res.json({ url: `https://github.com/apps/${encodeURIComponent(gh.slug)}/installations/new?state=${encodeURIComponent(state)}`, state });
    }),
  );

  // Wallet from the signed `state` (GitHub forwards it to the setup URL). When GitHub drops it, the
  // web callback page can still call this route with the session Bearer token instead.
  const walletFromStateOrSession: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const fromState = state ? verifyInstallState(state, deps.stateSecret()) : null;
    if (fromState) {
      // A caller that also sends a session must be the principal the state was minted for (ADR-9).
      // A bare browser redirect from GitHub carries no session: the state alone identifies it.
      if (req.get("authorization")) {
        requireWallet(req, res, () => {
          if (verifyInstallStateFor(state, req.wallet ?? "", deps.stateSecret())) next();
          else res.status(403).json({ error: "this install state was issued to another account — start again from GET /github/install-url" });
        });
        return;
      }
      req.wallet = fromState;
      next();
      return;
    }
    if (state && !req.get("authorization")) {
      res.status(400).json({ error: "invalid or expired state — start again from GET /github/install-url" });
      return;
    }
    requireWallet(req, res, next);
  };

  router.get(
    "/github/callback",
    walletFromStateOrSession,
    wrap(async (req, res) => {
      const walletAddr = wallet(req);
      const installationId = Number(req.query.installation_id);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new HttpError(400, "installation_id is required");
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!code) {
        // The App requests user authorization on install, so GitHub always sends `code`. Without it
        // we cannot prove the caller installed this installation id (ids are guessable).
        throw new HttpError(400, "code is required (the GitHub App asks for user authorization on install)");
      }
      const gh = github();
      if (!(await gh.userCanAccessInstallation(code, installationId))) {
        throw new HttpError(403, "the GitHub user who authorized this flow cannot access that installation");
      }
      const account = await gh.getInstallationAccount(installationId);
      if (!account) throw new HttpError(404, "installation not found for the TestMyAgent GitHub App");
      const bound = await repo.bindInstallation({ installationId, ownerWallet: walletAddr, accountLogin: account.login || null });
      if (!bound) throw new HttpError(409, "this installation is already connected to another wallet");
      res.json({ installationId, accountLogin: bound.accountLogin, ownerWallet: bound.ownerWallet });
    }),
  );

  router.get(
    "/github/installations",
    requireWallet,
    wrap(async (req, res) => {
      res.json({ installations: await repo.listInstallations(wallet(req)) });
    }),
  );

  router.get(
    "/github/repos",
    requireWallet,
    wrap(async (req, res) => {
      const installations = await repo.listInstallations(wallet(req));
      const gh = github();
      const repos = [];
      for (const inst of installations) {
        for (const r of await gh.listInstallationRepos(inst.installationId)) {
          repos.push({ installationId: inst.installationId, accountLogin: inst.accountLogin, ...r });
        }
      }
      res.json({ repos });
    }),
  );

  router.get(
    "/github/repos/:owner/:repo/agent-candidates",
    requireWallet,
    wrap(async (req, res) => {
      const repoFullName = `${req.params.owner}/${req.params.repo}`;
      const installationId = await installationFor(wallet(req), repoFullName, { kind: "agent", sample: wantsSample(req.query.source) });
      const gh = github();
      const ref = typeof req.query.ref === "string" && req.query.ref ? req.query.ref : undefined;
      let commitSha: string;
      if (ref === undefined) {
        commitSha = await gh.resolveHead(installationId, repoFullName);
      } else {
        const asCommit = COMMIT_INPUT_RE.test(ref);
        commitSha = (await resolveCommit(installationId, repoFullName, asCommit ? { commit: ref } : { branch: ref })).commitSha;
      }
      const tree = await gh.listTree(installationId, repoFullName, commitSha);
      res.json({ repoFullName, commitSha, truncatedTree: tree.truncated, candidates: findAgentCandidates(tree.entries) });
    }),
  );

  router.get(
    "/github/repos/:owner/:repo/task-candidates",
    requireWallet,
    wrap(async (req, res) => {
      const repoFullName = `${req.params.owner}/${req.params.repo}`;
      const installationId = await installationFor(wallet(req), repoFullName, { kind: "task", sample: wantsSample(req.query.source) });
      const gh = github();
      const ref = typeof req.query.ref === "string" && req.query.ref ? req.query.ref : undefined;
      let commitSha: string;
      if (ref === undefined) {
        commitSha = await gh.resolveHead(installationId, repoFullName);
      } else {
        const asCommit = COMMIT_INPUT_RE.test(ref);
        commitSha = (await resolveCommit(installationId, repoFullName, asCommit ? { commit: ref } : { branch: ref })).commitSha;
      }
      const tree = await gh.listTree(installationId, repoFullName, commitSha);
      const { candidates, capped } = await findTaskCandidates(gh, installationId, repoFullName, tree.entries);
      res.json({ repoFullName, commitSha, truncatedTree: tree.truncated, capped, candidates });
    }),
  );

  router.get(
    "/github/repos/:owner/:repo/branches",
    requireWallet,
    wrap(async (req, res) => {
      const repoFullName = `${req.params.owner}/${req.params.repo}`;
      const installationId = await installationFor(wallet(req), repoFullName, { sample: wantsSample(req.query.source) });
      const gh = github();
      const [meta, branches] = await Promise.all([gh.getRepo(installationId, repoFullName), gh.listBranches(installationId, repoFullName)]);
      // Default branch first, then by name: the select on 02 and on the task editor opens on it.
      const rows = branches
        .map((b) => ({ name: b.name, headSha: b.headSha, shortSha: b.headSha.slice(0, 7), isDefault: b.name === meta.defaultBranch }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
      res.json({ repoFullName, defaultBranch: meta.defaultBranch, branches: rows });
    }),
  );

  router.get(
    "/github/repos/:owner/:repo/commits",
    requireWallet,
    wrap(async (req, res) => {
      const repoFullName = `${req.params.owner}/${req.params.repo}`;
      const installationId = await installationFor(wallet(req), repoFullName, { sample: wantsSample(req.query.source) });
      const gh = github();
      const rawBranch = typeof req.query.branch === "string" && req.query.branch ? req.query.branch : undefined;
      if (rawBranch !== undefined && !isValidBranchName(rawBranch)) throw new HttpError(400, "branch is not a valid branch name");
      let limit = COMMITS_DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > COMMITS_MAX_LIMIT) throw new HttpError(400, `limit must be an integer from 1 to ${COMMITS_MAX_LIMIT}`);
      }
      const branch = rawBranch ?? (await gh.getRepo(installationId, repoFullName)).defaultBranch;
      // One call, no pagination (Gate Q4): the select shows the latest `limit` commits, HEAD first.
      const commits = await gh.listCommits(installationId, repoFullName, branch, limit);
      res.json({
        repoFullName,
        branch,
        headSha: commits[0]?.sha ?? null,
        commits: commits.map((c, i) => ({ sha: c.sha, shortSha: c.sha.slice(0, 7), message: c.message, date: c.date, authorName: c.authorName, isHead: i === 0 })),
      });
    }),
  );

  router.post(
    "/agents/validate",
    requireWallet,
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { repoFullName?: unknown; agentPath?: unknown; branch?: unknown; commit?: unknown; commitSha?: unknown; source?: unknown };
      if (typeof body.repoFullName !== "string") throw new HttpError(400, "repoFullName is required (owner/repo)");
      let agentPath: string;
      try {
        agentPath = normalizeAgentPath(body.agentPath);
      } catch (e) {
        throw new HttpError(400, e instanceof AgentPathError ? e.message : "invalid agentPath");
      }
      const { installationId, source } = await resolveInstallation(wallet(req), body.repoFullName, { kind: "agent", sample: wantsSample(body.source) });
      const { commitSha, branch } = await resolveCommit(installationId, body.repoFullName, { branch: body.branch, commit: body.commit ?? body.commitSha });
      const tree = await github().listTree(installationId, body.repoFullName, commitSha);
      const picked = selectAgentFiles(tree.entries, agentPath);
      const base = {
        repoFullName: body.repoFullName,
        source,
        branch,
        agentPath,
        commit: commitSha,
        shortCommit: commitSha.slice(0, 7),
        truncatedTree: tree.truncated,
      };
      if (!picked.ok) {
        const where = `${agentPath === "." ? "the repo root" : agentPath} at ${commitSha.slice(0, 7)}`;
        res.json({
          ...base,
          ok: false,
          files: [],
          summary: null,
          errorCode: picked.reason,
          error:
            picked.reason === "no_agent_file"
              ? `No AGENTS.md or CLAUDE.md in ${where}.`
              : `Agent files total ${picked.totalBytes} bytes at ${where}, above the ${AGENT_FILES_MAX_BYTES}-byte cap.`,
          // Paths that do hold an agent file, so the form can offer them.
          candidates: findAgentCandidates(tree.entries).map((c) => c.path),
        });
        return;
      }
      const files = picked.entries.map((e) => ({ path: e.relPath, bytes: e.size }));
      const sum = summarizeAgentFiles(files.map((f) => ({ path: f.path, size: f.bytes })));
      res.json({ ...base, ok: true, files, summary: sum.summary, skillCount: sum.skillCount, totalBytes: sum.totalBytes });
    }),
  );

  router.post(
    "/agents",
    requireWallet,
    wrap(async (req, res) => {
      const walletAddr = wallet(req);
      const body = (req.body ?? {}) as {
        repoFullName?: unknown;
        agentPath?: unknown;
        model?: unknown;
        name?: unknown;
        branch?: unknown;
        commit?: unknown;
        commitSha?: unknown;
        modelRelease?: unknown;
        description?: unknown;
        visibility?: unknown;
        requires?: unknown;
        source?: unknown;
      };
      if (typeof body.repoFullName !== "string") throw new HttpError(400, "repoFullName is required (owner/repo)");
      const requires = body.requires === undefined || body.requires === null ? undefined : requiresOf(body.requires);
      let agentPath: string;
      try {
        agentPath = normalizeAgentPath(body.agentPath);
      } catch (e) {
        throw new HttpError(400, e instanceof AgentPathError ? e.message : "invalid agentPath");
      }
      const model = body.model ?? DEFAULT_AGENT_MODEL;
      const allowed = deps.isModelAllowed
        ? typeof model === "string" && (await deps.isModelAllowed(model))
        : isAllowedModel(model);
      if (!allowed || typeof model !== "string") {
        throw new HttpError(400, "model is not in the allow-list (GET /models)", deps.isModelAllowed ? {} : { allowed: AGENT_MODELS.map((m) => m.id) });
      }
      const defaultName = agentPath === "." ? body.repoFullName : `${body.repoFullName}/${agentPath}`;
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : defaultName;
      if (name.length > 120) throw new HttpError(400, "name must be at most 120 characters");
      let description: string | undefined;
      if (body.description !== undefined && body.description !== null) {
        if (typeof body.description !== "string") throw new HttpError(400, "description must be a string");
        description = body.description.trim();
        if (description.length > AGENT_DESCRIPTION_MAX) throw new HttpError(400, `description must be at most ${AGENT_DESCRIPTION_MAX} characters`);
      }
      let visibility: "private" | "listed" = "listed";
      if (body.visibility !== undefined) {
        if (body.visibility !== "private" && body.visibility !== "listed") throw new HttpError(400, "visibility must be private or listed");
        visibility = body.visibility;
      }
      let modelRelease: string | undefined;
      if (body.modelRelease !== undefined && body.modelRelease !== null && body.modelRelease !== "") {
        if (typeof body.modelRelease !== "string" || !MODEL_RELEASE_RE.test(body.modelRelease)) throw new HttpError(400, "modelRelease must be a model release id");
        modelRelease = body.modelRelease;
      }

      const { installationId, source } = await resolveInstallation(walletAddr, body.repoFullName, { kind: "agent", sample: wantsSample(body.source) });
      const pin = await resolveCommit(installationId, body.repoFullName, { branch: body.branch, commit: body.commit ?? body.commitSha });
      const snap = await snapshot(installationId, body.repoFullName, agentPath, pin.commitSha);
      const agent = await repo.upsertGithubAgent({ ownerWallet: walletAddr, name, installationId, repoFullName: body.repoFullName, agentPath, model });
      // makeCurrent: a re-pin to an older commit makes that version the one POST /runs runs.
      const version = await repo.createAgentVersion({ agentId: agent.id, commitSha: snap.commitSha, files: snap.files, makeCurrent: true });
      const meta = await repo.updateAgentMeta(agent.id, {
        branch: pin.branch,
        pinnedCommit: snap.commitSha,
        visibility,
        ...(description !== undefined ? { description } : {}),
        ...(modelRelease !== undefined ? { modelRelease } : {}),
        ...(requires !== undefined ? { requires } : {}),
        source,
        slugBase: slugify(name),
      });
      const saved = await repo.getGithubAgent(agent.id);
      res.status(201).json({
        agent: saved && withSource(saved),
        version: { id: version.id, commitSha: version.commitSha, files: fileSummary(version.files), createdAt: version.createdAt },
        pinned: { branch: pin.branch, commitSha: snap.commitSha, shortSha: snap.commitSha.slice(0, 7) },
        summary: summarizeAgentFiles(version.files).summary,
        // Fields the DB could not store yet (agents columns of the U6 migration not applied).
        ...(meta.missing.length > 0 ? { warnings: [`not stored until the agents columns migration is applied: ${meta.missing.join(", ")}`] } : {}),
      });
    }),
  );

  router.get(
    "/agents",
    requireWallet,
    wrap(async (req, res) => {
      const agents: unknown[] = (await repo.listGithubAgents(wallet(req))).map(withSource);
      // L4: local agents (connector 'local', no repo) only on request, so a client that reads
      // repoFullName of every row keeps working.
      const include = String(req.query.include ?? "").split(",");
      if (include.includes("local") && deps.localAgents) agents.push(...(await deps.localAgents(wallet(req))));
      res.json({ agents });
    }),
  );

  async function ownAgent(req: Request) {
    if (!UUID_RE.test(String(req.params.id))) throw new HttpError(404, "agent not found");
    const agent = await repo.getGithubAgent(String(req.params.id));
    if (!agent || agent.ownerWallet !== wallet(req)) throw new HttpError(404, "agent not found");
    return agent;
  }

  router.get(
    "/agents/:id",
    requireWallet,
    wrap(async (req, res) => {
      res.json({ agent: withSource(await ownAgent(req)) });
    }),
  );

  // U28 (ADR-11): the agent's requirements — MCP servers / built-in tools it needs from a task.
  // Stored on the agent (not parsed from AGENTS.md). The quote refuses a task that lacks one.
  router.patch(
    "/agents/:id",
    requireWallet,
    wrap(async (req, res) => {
      const agent = await ownAgent(req);
      const body = (req.body ?? {}) as { requires?: unknown; model_id?: unknown };
      if (body.requires === undefined && body.model_id === undefined) throw new HttpError(400, "nothing to update: send requires (array) or model_id");
      const requires = body.requires === undefined ? undefined : requiresOf(body.requires);
      // L4: the model of a GitHub agent, checked as POST /agents checks it (a hosted run spends TMA credits).
      let model: string | undefined;
      if (body.model_id !== undefined) {
        const allowed = deps.isModelAllowed
          ? typeof body.model_id === "string" && (await deps.isModelAllowed(body.model_id))
          : isAllowedModel(body.model_id);
        if (!allowed || typeof body.model_id !== "string") throw new HttpError(400, "model_id is not in the allow-list (GET /models)");
        model = body.model_id;
      }
      const meta = await repo.updateAgentMeta(agent.id, { ...(requires !== undefined ? { requires } : {}), ...(model !== undefined ? { model } : {}) });
      if (meta.missing.includes("requires")) throw new HttpError(503, "requires is not stored until migration 0011_agent_requires is applied");
      const saved = await repo.getGithubAgent(agent.id);
      res.json({ agent: saved && withSource(saved) });
    }),
  );

  router.post(
    "/agents/:id/refresh",
    requireWallet,
    wrap(async (req, res) => {
      const agent = await ownAgent(req);
      // Re-check the binding: the user may have uninstalled the App or moved the repo since.
      const installationId = await installationFor(agent.ownerWallet, agent.repoFullName, { kind: "agent", sample: agent.source === "sample" });
      // An agent registered on a branch refreshes to that branch's HEAD; older agents to the default branch.
      const pin = await resolveCommit(installationId, agent.repoFullName, { branch: agent.branch ?? undefined });
      const snap = await snapshot(installationId, agent.repoFullName, agent.agentPath, pin.commitSha);
      if (agent.pinnedCommit !== undefined) await repo.updateAgentMeta(agent.id, { pinnedCommit: snap.commitSha });
      const changed = agent.latestVersion?.commitSha !== snap.commitSha;
      const version = await repo.createAgentVersion({ agentId: agent.id, commitSha: snap.commitSha, files: snap.files, makeCurrent: true });
      const saved = await repo.getGithubAgent(agent.id);
      res.json({
        changed,
        agent: saved && withSource(saved),
        version: { id: version.id, commitSha: version.commitSha, files: fileSummary(version.files), createdAt: version.createdAt },
      });
    }),
  );

  return router;
}
