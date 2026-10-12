import cors from "cors";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import { CORS_ALLOWED_ORIGINS, RATE_LIMIT } from "./config.js";
import { createAuthRouter } from "./http/auth.js";
import { createCredentialsRouter } from "./http/credentials-router.js";
import { createEvaluationRequestsRouter } from "./http/evaluation-requests-router.js";
import { createLegacyGoneRouter, RETIRED_ROUTES } from "./http/legacy-gone-router.js";
import { createEvaluationsV2Router, type EvaluationsRouterDeps } from "./evaluations/router.js";
import { createNftRouter } from "./http/nft-router.js";
import { createAgentsRankingRouter, defaultAgentsRankingRouterDeps, type AgentsRankingRouterDeps } from "./http/agents-ranking-router.js";
import { createAgentProfileRouter, defaultAgentProfileRouterDeps, type AgentProfileRouterDeps } from "./http/agent-profile-router.js";
import { createGithubRouter, defaultGithubRouterDeps, type GithubRouterDeps } from "./http/github-router.js";
import { createProofsRouter } from "./http/proofs-router.js";
import { createPublicRouter } from "./public/router.js";
import type { PublicProfilesStore } from "./public/store.js";
import type { ProofStore } from "./chain/proof-store.js";
import { createCatalogRouter, modelAccessCheck, type CatalogRouterOptions } from "./http/catalog-router.js";
import type { CatalogStore } from "./domain/catalog-store.js";
import { createTaskPacksRouter } from "./http/task-packs-router.js";
import { createRunsRouter, type RunsRouterDeps } from "./http/runs-router.js";
import type { Repository } from "./domain/repository.js";

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
  "GET /tags?kind=",
  "GET /me",
  "PATCH /me",
  "GET /models/:id/access",
  "POST /admin/models/sync",
  "GET /public/evaluations/:slugOrHash",
  "GET /public/evaluations/:slugOrHash/manifest.json",
  "GET /public/evaluations/:slugOrHash/og.png",
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
  /** U21: the on-demand OpenRouter sync and the admin allow-list. */
  catalogOptions?: CatalogRouterOptions;
  /** Evaluations v2 (quote, Solana Pay, batch of runs). Mounted only when given. */
  evaluations?: EvaluationsRouterDeps;
  /** U14: public evaluation profile (screen 05). Mounted only when given. */
  publicProfiles?: PublicProfilesStore;
}

export function createApp(repo: Repository, options: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");

  // Dedicated to Dokploy's healthcheck (apps/api/Dockerfile HEALTHCHECK). Kept separate from "/"
  // on purpose: a healthcheck should be as cheap and stable as possible, not carry service
  // metadata that changes with every version bump. Not rate-limited or CORS-gated — it's an
  // infra-to-infra check, not a public API call.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(
    cors({
      origin: CORS_ALLOWED_ORIGINS,
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(
    rateLimit({
      windowMs: RATE_LIMIT.WINDOW_MS,
      limit: RATE_LIMIT.MAX_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(express.json());

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

  app.use(createAuthRouter());
  if (options.runs) app.use(createRunsRouter({ repo, ...options.runs }));
  // Before the 410 router: both answer POST /evaluations (the v2 one falls through on a legacy
  // body).
  if (options.evaluations) app.use(createEvaluationsV2Router(options.evaluations));
  // Retired vendor-endpoint flow: 410 Gone (no local grading in this process).
  app.use(createLegacyGoneRouter());
  app.use(createCredentialsRouter(repo));
  app.use(createEvaluationRequestsRouter(repo));
  app.use(createTaskPacksRouter(repo));
  app.use(createNftRouter());
  if (options.catalog) app.use(createCatalogRouter(options.catalog, options.catalogOptions));
  const githubDeps = options.github ?? defaultGithubRouterDeps();
  // U21: POST /agents checks the model against models.enabled (DB) when the catalog is wired.
  if (options.catalog && !githubDeps.isModelAllowed) githubDeps.isModelAllowed = modelAccessCheck(options.catalog);
  // Before the GitHub router: its GET /agents/:id would take "ranking" as an id.
  app.use(createAgentsRankingRouter(options.ranking ?? defaultAgentsRankingRouterDeps()));
  app.use(createAgentProfileRouter(options.profile ?? defaultAgentProfileRouterDeps()));
  app.use(createGithubRouter(githubDeps));
  if (options.proofs) app.use(createProofsRouter({ store: options.proofs }));
  if (options.publicProfiles) app.use(createPublicRouter({ store: options.publicProfiles }));

  return app;
}
