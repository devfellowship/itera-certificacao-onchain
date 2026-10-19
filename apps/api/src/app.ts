import cors from "cors";
import express, { type Express } from "express";
import { CORS_ALLOWED_ORIGINS, TRUST_PROXY_HOPS } from "./config.js";
import { createHealthHandler, type HealthDeps } from "./http/health.js";
import { createRateLimiters } from "./http/rate-limit.js";
import { createAuthRouter } from "./http/auth.js";
import { createAccountGuard } from "./auth/account-guard.js";
import type { DflAuthDeps } from "./auth/adapters/dfl.js";
import { createCredentialsRouter } from "./http/credentials-router.js";
import { createEvaluationRequestsRouter } from "./http/evaluation-requests-router.js";
import { createLegacyGoneRouter, RETIRED_ROUTES } from "./http/legacy-gone-router.js";
import { createEvaluationsV2Router, type EvaluationsRouterDeps } from "./evaluations/router.js";
import { createCompatibilityRouter } from "./evaluations/compatibility.js";
import { createNftRouter } from "./http/nft-router.js";
import { createAgentsRankingRouter, defaultAgentsRankingRouterDeps, type AgentsRankingRouterDeps } from "./http/agents-ranking-router.js";
import { createAgentProfileRouter, defaultAgentProfileRouterDeps, type AgentProfileRouterDeps } from "./http/agent-profile-router.js";
import { createGithubRouter, defaultGithubRouterDeps, type GithubRouterDeps } from "./http/github-router.js";
import { createProofsRouter } from "./http/proofs-router.js";
import { createFeedbackRouter } from "./http/feedback-router.js";
import type { ReputationStore } from "./domain/reputation-store.js";
import { createPublicRouter } from "./public/router.js";
import { createPublicTaskRouter } from "./public/task-router.js";
import type { PublicTaskStore } from "./public/task-store.js";
import type { PublicProfilesStore } from "./public/store.js";
import type { ProofStore } from "./chain/proof-store.js";
import { createCatalogRouter, modelAccessCheck, type CatalogRouterOptions } from "./http/catalog-router.js";
import type { CatalogStore } from "./domain/catalog-store.js";
import { createTaskPacksRouter } from "./http/task-packs-router.js";
import { createMyTasksRouter, type MyTasksRouterDeps } from "./http/my-tasks-router.js";
import { createRunsRouter, RUN_FEE_USD, RUN_MAX_COST_USD, type RunsRouterDeps } from "./http/runs-router.js";
import { createMcpCatalogRouter } from "./http/mcp-catalog-router.js";
import type { McpCatalogStore } from "./domain/mcp-catalog.js";
import type { Repository } from "./domain/repository.js";
import { createProfileRouter } from "./http/profile-router.js";
import { profileEnrichment } from "./http/profile-enrich.js";
import type { AvatarStorage } from "./domain/avatar.js";
import type { AgentAvatarStore } from "./domain/agent-avatar-store.js";
import { createFaucetRouter, type FaucetRouterDeps } from "./http/faucet-router.js";
import { createModelsAccessRouter, type ModelsAccessRouterDeps } from "./http/models-access-router.js";

export const SERVICE_NAME = "testmyagent-api";
export const PRODUCT_NAME = "TestMyAgent";
export const SERVICE_DESCRIPTION = "TestMyAgent API: verifiable, per-task evidence for coding agents.";
export const API_VERSION = "0.4.0";

const ROUTES = [
  "/",
  "/health",
  "/hello-world",
  "POST /auth/nonce",
  "POST /auth/verify",
  "POST /auth/dfl/exchange",
  "GET /auth/me",
  "POST /runs",
  "GET /runs?mine=1",
  "GET /runs/:id",
  "POST /runs/:id/publish",
  "POST /evaluations/quote",
  "POST /evaluations/quote/:reference/transaction",
  "POST /evaluations",
  "GET /evaluations?scope=all|my_agents|others",
  "GET /evaluations/:id",
  "POST /evaluations/:id/cancel",
  "GET /credentials/:id",
  "GET /credentials/:id/verify",
  "GET /credentials/:id/export",
  "POST /evaluation-requests",
  "GET /task-packs",
  "GET /nft/:mint.json",
  "GET /nft/:mint.png",
  "GET /models",
  "GET /models/:id/estimate?task=&version=",
  "GET /github/install-url",
  "GET /github/callback",
  "GET /github/installations",
  "GET /github/repos",
  "GET /github/repos/:owner/:repo/agent-candidates",
  "GET /github/repos/:owner/:repo/branches",
  "GET /github/repos/:owner/:repo/commits?branch=&limit=20",
  "POST /agents/validate",
  "GET /agents/ranking?scope=&q=&taskIds=&tag=",
  "POST /agents",
  "GET /agents",
  "GET /agents/:id",
  "PATCH /agents/:id",
  "GET /tasks/:idOrSlug/compatibility?agentId=",
  "GET /agents/:idOrSlug/profile",
  "GET /agents/:idOrSlug/my-results",
  "GET /badge/agents/:slug.svg",
  "GET /badge/evaluations/:slug.svg",
  "GET /b/:slug.svg",
  "POST /agents/:id/refresh",
  "POST /runs/:id/start-signature",
  "GET /proofs/:hash",
  "GET /leaderboard?benchmark=&version=",
  "GET /tasks?source=&tag=&kind=&runnable=&q=",
  "GET /tasks/:idOrSlug",
  "GET /tasks/:idOrSlug/evaluations",
  "POST /tasks/layout",
  "POST /tasks",
  "PATCH /tasks/:id",
  "DELETE /tasks/:id",
  "GET /tasks/:id/versions",
  "POST /tasks/:id/versions",
  "POST /tasks/:id/versions/:v/validate",
  "POST /tasks/:id/validate",
  "GET /tasks/:id/versions/:v/validation",
  "GET /tasks/:id/validations/:validationId",
  "GET /tags?kind=",
  "GET /me",
  "PATCH /me",
  "GET /usernames/:name/available",
  "GET /public/users/:username",
  "POST /me/avatar",
  "DELETE /me/avatar",
  "PUT /admin/profiles/:wallet",
  "POST /agents/:id/avatar",
  "DELETE /agents/:id/avatar",
  "PATCH /agents/:id/profile",
  "PUT /admin/agents/:id/avatar",
  "GET /models/:id/access",
  "POST /models/access",
  "POST /admin/models/sync",
  "GET /public/evaluations/:slugOrHash",
  "GET /public/evaluations/:slugOrHash/manifest.json",
  "GET /public/evaluations/:slugOrHash/og.png",
  "GET /public/tasks/:slug?v=",
  "GET /public/tasks/:slug/schemas.json",
  "POST /runs/:id/feedback",
  "GET /runs/:id/feedback",
  "GET /tasks/:idOrSlug/reputation",
  "GET /mcp-catalog",
  "GET /github/sample-repos",
  "GET /faucet",
  "POST /faucet",
];

/**
 * `repo` is injected so tests run against FakeRepository (no live Postgres needed); production
 * wires PgRepository via a lazy getPool() call in server.ts, only at process start — never
 * imported eagerly here, so this module stays testable without DATABASE_URL set.
 */
export interface AppOptions {
  /** The async wallet-owned runs flow. Mounted only when a RunsStore is given. */
  runs?: Omit<RunsRouterDeps, "repo">;
  /** The GitHub App agent connector. Defaults to the Pg store + the GITHUB_APP_* env client. */
  github?: GithubRouterDeps;
  /** GET /agents/ranking (U8). Defaults to the Pg store + an indicative CoinGecko SOL/USD rate. */
  ranking?: AgentsRankingRouterDeps;
  /** GET /agents/:id/profile, /my-results and the README badges (U15, U16). Defaults to the Pg store. */
  profile?: AgentProfileRouterDeps;
  /** Lane D proofs (start-signature, /proofs/:hash, /leaderboard). Mounted only when given. */
  proofs?: ProofStore;
  /** U5 catalog (tasks, tags, models from DB, profile). Mounted before the GitHub router so its
   * GET /models (DB) wins over the static one. */
  catalog?: CatalogStore;
  /** U19 My tasks (needs 0009_user_tasks). Mounted before the catalog: its owner GET /tasks/:id wins. */
  myTasks?: MyTasksRouterDeps;
  /** U21: the on-demand OpenRouter sync and the admin allow-list. */
  catalogOptions?: CatalogRouterOptions;
  /** Evaluations v2 (quote, Solana Pay, batch of runs). Mounted only when given. */
  evaluations?: EvaluationsRouterDeps;
  /** U14: public evaluation profile (screen 05). Mounted only when given. */
  publicProfiles?: PublicProfilesStore;
  /** U27: run feedback + task reputation (0010). Mounted only when given. */
  reputation?: ReputationStore;
  /** U30: public task profile (/tasks/:slug). Mounted only when given. */
  publicTasks?: PublicTaskStore;
  /** U29: Itera MCP catalog (needs 0013_mcp_catalog.sql). */
  mcpCatalog?: McpCatalogStore;
  /** U36: picture storage (public `avatars` bucket). Null/absent → the upload routes answer 503.
   * Profiles (username, display name, picture) join every response that names a wallet when the
   * catalog store is wired (http/profile-enrich.ts). */
  avatarStorage?: AvatarStorage | null;
  /** U36: agent pictures (needs 0015). Mounts POST/DELETE /agents/:id/avatar and the admin seed. */
  agentAvatars?: AgentAvatarStore;
  /** U37: devnet faucet (needs 0016_sample_repos_faucet.sql). Mounted only when given. */
  faucet?: FaucetRouterDeps;
  /** T5 Login with DFL (needs 0018_users_principal.sql). Without a users store the exchange answers
   * 503 dfl_auth_not_configured; the SIWS routes do not depend on it. */
  dflAuth?: DflAuthDeps;
  /** T8: POST /models/access (the BYOK OpenRouter key check). Always mounted; a test injects fetch. */
  modelsAccess?: ModelsAccessRouterDeps;
  /** T12: DB ping + queue depth + runner heartbeat on GET /health. Absent → the minimal `{status:"ok"}`. */
  health?: HealthDeps;
}

export function createApp(repo: Repository, options: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  // Behind Dokploy's Traefik: trust exactly that many X-Forwarded-For hops so `req.ip` (and with it
  // the rate-limit bucket) is the real client, not the proxy. See TRUST_PROXY_HOPS in config.ts.
  app.set("trust proxy", TRUST_PROXY_HOPS);

  // Dedicated to Dokploy's healthcheck (apps/api/Dockerfile HEALTHCHECK). Kept separate from "/"
  // on purpose: a healthcheck should be as cheap and stable as possible, not carry service
  // metadata that changes with every version bump. Not rate-limited or CORS-gated — it's an
  // infra-to-infra check, not a public API call.
  // T12: with `options.health` it also pings the DB and reports the queue depth and the runner
  // heartbeat (http/health.ts). Without it (unit tests, no database) it keeps answering {"status":"ok"}.
  // `status: "ok"` stays in every 200 body, so the Docker HEALTHCHECK and the CI curl are unchanged.
  app.get("/health", options.health ? createHealthHandler(options.health) : (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(
    cors({
      origin: CORS_ALLOWED_ORIGINS,
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(createRateLimiters());
  // ADR-9 kill switch: `users.disabled` → 403 account_disabled on every write route of a dfl principal.
  if (options.dflAuth?.users) app.use(createAccountGuard({ users: options.dflAuth.users }));
  app.use(express.json());
  // U36: owner/author profiles next to every wallet field of a JSON response.
  if (options.catalog) {
    const catalog = options.catalog;
    const agentAvatars = options.agentAvatars;
    app.use(profileEnrichment((wallets) => catalog.listProfiles(wallets), agentAvatars ? (ids, slugs) => agentAvatars.listAvatars(ids, slugs) : undefined));
  }

  app.get("/", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      name: PRODUCT_NAME,
      description: SERVICE_DESCRIPTION,
      status: "ok",
      version: API_VERSION,
      routes: ROUTES,
      retired: RETIRED_ROUTES,
    });
  });

  app.get("/hello-world", (_req, res) => {
    res.type("text/plain").send("Hello, world!");
  });

  app.use(createAuthRouter({ dfl: options.dflAuth }));
  app.use(createModelsAccessRouter(options.modelsAccess));
  if (options.runs) app.use(createRunsRouter({ repo, ...options.runs }));
  // Before the 410 router: both answer POST /evaluations (the v2 one falls through on a legacy
  // body).
  if (options.evaluations) app.use(createEvaluationsV2Router(options.evaluations));
  // Retired vendor-endpoint flow: 410 Gone (no local grading in this process).
  app.use(createLegacyGoneRouter());
  // U28: GET /tasks/:idOrSlug/compatibility (no collision with the catalog's GET /tasks/:idOrSlug).
  if (options.evaluations) app.use(createCompatibilityRouter({ store: options.evaluations.store }));
  app.use(createCredentialsRouter(repo));
  app.use(createEvaluationRequestsRouter(repo));
  app.use(createTaskPacksRouter(repo));
  app.use(createNftRouter());
  if (options.myTasks) app.use(createMyTasksRouter(options.myTasks));
  if (options.catalog) app.use(createCatalogRouter(options.catalog, options.catalogOptions));
  if (options.catalog) {
    app.use(createProfileRouter({ store: options.catalog, storage: options.avatarStorage ?? null, adminWallets: options.catalogOptions?.adminWallets, agents: options.agentAvatars }));
  }
  const githubDeps = options.github ?? defaultGithubRouterDeps();
  // U21: POST /agents checks the model against models.enabled (DB) when the catalog is wired.
  if (options.catalog && !githubDeps.isModelAllowed) githubDeps.isModelAllowed = modelAccessCheck(options.catalog);
  // Before the GitHub router: its GET /agents/:id would take "ranking" as an id.
  app.use(createAgentsRankingRouter(options.ranking ?? defaultAgentsRankingRouterDeps()));
  app.use(createAgentProfileRouter(options.profile ?? defaultAgentProfileRouterDeps()));
  app.use(createGithubRouter(githubDeps));
  if (options.proofs) app.use(createProofsRouter({ store: options.proofs }));
  if (options.publicProfiles) app.use(createPublicRouter({ store: options.publicProfiles }));
  if (options.reputation) app.use(createFeedbackRouter({ store: options.reputation }));
  if (options.publicTasks) {
    app.use(createPublicTaskRouter({ store: options.publicTasks, reputation: options.reputation, costCapUsd: RUN_MAX_COST_USD, runFeeUsd: RUN_FEE_USD }));
  }
  if (options.mcpCatalog) app.use(createMcpCatalogRouter(options.mcpCatalog));
  if (options.faucet) app.use(createFaucetRouter(options.faucet));

  return app;
}
