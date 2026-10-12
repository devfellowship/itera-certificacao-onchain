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
  type AgentFile,
} from "../github/agent-files.js";
import { GitHubApiError, GitHubAppClient, GitHubConfigError, githubAppConfigFromEnv, type GitHubAppApi } from "../github/app-client.js";
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, isAllowedModel } from "../github/models.js";
import { signInstallState, verifyInstallState } from "../github/state.js";
import { requireWallet as defaultRequireWallet } from "./auth.js";

/**
 * GitHub App agent connector (lane C, ADR-2): a user installs the read-only Itera GitHub App on the
 * repos that hold agents; Itera reads AGENTS.md / CLAUDE.md / skills/** at a pinned commit SHA.
 *
 *   GET  /models                                       public — model allow-list
 *   GET  /github/install-url                           wallet — install URL with signed state
 *   GET  /github/callback?installation_id&state&code   binds the installation to the wallet
 *   GET  /github/installations                         wallet
 *   GET  /github/repos                                 wallet — repos the App can read
 *   GET  /github/repos/:owner/:repo/agent-candidates   wallet — dirs with AGENTS.md / CLAUDE.md
 *   POST /agents {repoFullName, agentPath, model, name} wallet — snapshot at HEAD → agent + version
 *   GET  /agents                                       wallet — my agents
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

type Handler = (req: Request, res: Response) => Promise<void>;

/** Maps domain errors to JSON responses; never leaks a stack or a token. */
function wrap(fn: Handler): RequestHandler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        res.status(e.status).json({ error: e.message, ...e.extra });
      } else if (e instanceof SchemaNotReadyError) {
        res.status(503).json({ error: e.message });
      } else if (e instanceof GitHubConfigError) {
        res.status(503).json({ error: "the Itera GitHub App is not configured on this server yet" });
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

  /** The installation that covers this repo must be bound to the caller's wallet. Answers 404
   * otherwise, so a caller cannot probe which repos other wallets connected. */
  async function installationFor(walletAddr: string, repoFullName: string): Promise<number> {
    if (!REPO_FULL_NAME_RE.test(repoFullName)) throw new HttpError(400, "repoFullName must look like owner/repo");
    const installationId = await github().getRepoInstallationId(repoFullName);
    const inst = installationId === null ? null : await repo.getInstallation(installationId);
    if (installationId === null || !inst || inst.ownerWallet !== walletAddr) {
      throw new HttpError(404, "repo not connected: install the Itera GitHub App on it from this wallet");
    }
    return installationId;
  }

  /** Reads AGENTS.md, CLAUDE.md and skills/** under agentPath at the repo HEAD. */
  async function snapshot(installationId: number, repoFullName: string, agentPath: string): Promise<{ commitSha: string; files: AgentFile[] }> {
    const gh = github();
    const commitSha = await gh.resolveHead(installationId, repoFullName);
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
      if (!account) throw new HttpError(404, "installation not found for the Itera GitHub App");
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
      const installationId = await installationFor(wallet(req), repoFullName);
      const gh = github();
      const commitSha = await gh.resolveHead(installationId, repoFullName);
      const tree = await gh.listTree(installationId, repoFullName, commitSha);
      res.json({ repoFullName, commitSha, truncatedTree: tree.truncated, candidates: findAgentCandidates(tree.entries) });
    }),
  );

  router.post(
    "/agents",
    requireWallet,
    wrap(async (req, res) => {
      const walletAddr = wallet(req);
      const body = (req.body ?? {}) as { repoFullName?: unknown; agentPath?: unknown; model?: unknown; name?: unknown };
      if (typeof body.repoFullName !== "string") throw new HttpError(400, "repoFullName is required (owner/repo)");
      let agentPath: string;
      try {
        agentPath = normalizeAgentPath(body.agentPath);
      } catch (e) {
        throw new HttpError(400, e instanceof AgentPathError ? e.message : "invalid agentPath");
      }
      const model = body.model ?? DEFAULT_AGENT_MODEL;
      if (!isAllowedModel(model)) throw new HttpError(400, "model is not in the allow-list (GET /models)", { allowed: AGENT_MODELS.map((m) => m.id) });
      const defaultName = agentPath === "." ? body.repoFullName : `${body.repoFullName}/${agentPath}`;
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : defaultName;
      if (name.length > 120) throw new HttpError(400, "name must be at most 120 characters");

      const installationId = await installationFor(walletAddr, body.repoFullName);
      const snap = await snapshot(installationId, body.repoFullName, agentPath);
      const agent = await repo.upsertGithubAgent({ ownerWallet: walletAddr, name, installationId, repoFullName: body.repoFullName, agentPath, model });
      const version = await repo.createAgentVersion({ agentId: agent.id, commitSha: snap.commitSha, files: snap.files });
      res.status(201).json({
        agent: await repo.getGithubAgent(agent.id),
        version: { id: version.id, commitSha: version.commitSha, files: fileSummary(version.files), createdAt: version.createdAt },
      });
    }),
  );

  router.get(
    "/agents",
    requireWallet,
    wrap(async (req, res) => {
      res.json({ agents: await repo.listGithubAgents(wallet(req)) });
    }),
  );

  async function ownAgent(req: Request) {
    const agent = await repo.getGithubAgent(String(req.params.id));
    if (!agent || agent.ownerWallet !== wallet(req)) throw new HttpError(404, "agent not found");
    return agent;
  }

  router.get(
    "/agents/:id",
    requireWallet,
    wrap(async (req, res) => {
      res.json({ agent: await ownAgent(req) });
    }),
  );

  router.post(
    "/agents/:id/refresh",
    requireWallet,
    wrap(async (req, res) => {
      const agent = await ownAgent(req);
      // Re-check the binding: the user may have uninstalled the App or moved the repo since.
      const installationId = await installationFor(agent.ownerWallet, agent.repoFullName);
      const snap = await snapshot(installationId, agent.repoFullName, agent.agentPath);
      const changed = agent.latestVersion?.commitSha !== snap.commitSha;
      const version = await repo.createAgentVersion({ agentId: agent.id, commitSha: snap.commitSha, files: snap.files });
      res.json({
        changed,
        agent: await repo.getGithubAgent(agent.id),
        version: { id: version.id, commitSha: version.commitSha, files: fileSummary(version.files), createdAt: version.createdAt },
      });
    }),
  );

  return router;
}
