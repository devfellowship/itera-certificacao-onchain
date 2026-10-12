import cors from "cors";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import { CORS_ALLOWED_ORIGINS, RATE_LIMIT } from "./config.js";
import { createAuthRouter } from "./http/auth.js";
import { createAgentEndpointManifestsRouter } from "./http/agent-endpoint-manifests-router.js";
import { createCredentialsRouter } from "./http/credentials-router.js";
import { createEvaluationRequestsRouter } from "./http/evaluation-requests-router.js";
import { createEvaluationsRouter } from "./http/evaluations-router.js";
import { createNftRouter } from "./http/nft-router.js";
import { createGithubRouter, defaultGithubRouterDeps, type GithubRouterDeps } from "./http/github-router.js";
import { createProofsRouter } from "./http/proofs-router.js";
import type { ProofStore } from "./chain/proof-store.js";
import { createCatalogRouter, modelAccessCheck, type CatalogRouterOptions } from "./http/catalog-router.js";
import type { CatalogStore } from "./domain/catalog-store.js";
import { createTaskPacksRouter } from "./http/task-packs-router.js";
import { createRunsRouter, type RunsRouterDeps } from "./http/runs-router.js";
import type { Repository } from "./domain/repository.js";

export const SERVICE_NAME = "itera-agent-credentials-api";
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
  "POST /evaluations",
  "POST /evaluations/:id/dispatch",
  "GET /evaluations/:id/events",
  "POST /evaluations/:id/publish",
  "GET /credentials/:id",
  "GET /credentials/:id/verify",
  "GET /credentials/:id/export",
  "POST /evaluation-requests",
  "GET /task-packs",
  "POST /agent-endpoint-manifests",
  "GET /nft/:mint.json",
  "GET /nft/:mint.png",
  "GET /models",
  "GET /models/:id/estimate?task=&version=",
  "GET /github/install-url",
  "GET /github/callback",
  "GET /github/installations",
  "GET /github/repos",
  "GET /github/repos/:owner/:repo/agent-candidates",
  "POST /agents",
  "GET /agents",
  "GET /agents/:id",
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
  /** Lane D proofs (start-signature, /proofs/:hash, /leaderboard). Mounted only when given. */
  proofs?: ProofStore;
  /** U5 catalog (tasks, tags, models from DB, profile). Mounted before the GitHub router so its
   * GET /models (DB) wins over the static one. */
  catalog?: CatalogStore;
  /** U21: the on-demand OpenRouter sync and the admin allow-list. */
  catalogOptions?: CatalogRouterOptions;
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
      status: "ok",
      version: API_VERSION,
      routes: ROUTES,
    });
  });

  app.get("/hello-world", (_req, res) => {
    res.type("text/plain").send("Hello, world!");
  });

  app.use(createAuthRouter());
  if (options.runs) app.use(createRunsRouter({ repo, ...options.runs }));
  app.use(createEvaluationsRouter(repo));
  app.use(createCredentialsRouter(repo));
  app.use(createEvaluationRequestsRouter(repo));
  app.use(createTaskPacksRouter(repo));
  app.use(createAgentEndpointManifestsRouter());
  app.use(createNftRouter());
  if (options.catalog) app.use(createCatalogRouter(options.catalog, options.catalogOptions));
  const githubDeps = options.github ?? defaultGithubRouterDeps();
  // U21: POST /agents checks the model against models.enabled (DB) when the catalog is wired.
  if (options.catalog && !githubDeps.isModelAllowed) githubDeps.isModelAllowed = modelAccessCheck(options.catalog);
  app.use(createGithubRouter(githubDeps));
  if (options.proofs) app.use(createProofsRouter({ store: options.proofs }));

  return app;
}
