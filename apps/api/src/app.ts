import cors from "cors";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import { CORS_ALLOWED_ORIGINS, RATE_LIMIT } from "./config.js";
import { createCredentialsRouter } from "./http/credentials-router.js";
import { createEvaluationRequestsRouter } from "./http/evaluation-requests-router.js";
import { createEvaluationsRouter } from "./http/evaluations-router.js";
import type { Repository } from "./domain/repository.js";

export const SERVICE_NAME = "itera-agent-credentials-api";
export const API_VERSION = "0.3.0";

const ROUTES = [
  "/",
  "/health",
  "/hello-world",
  "POST /evaluations",
  "GET /evaluations/:id/events",
  "POST /evaluations/:id/publish",
  "GET /credentials/:id",
  "GET /credentials/:id/verify",
  "GET /credentials/:id/export",
  "POST /evaluation-requests",
];

/**
 * `repo` is injected so tests run against FakeRepository (no live Postgres needed); production
 * wires PgRepository via a lazy getPool() call in server.ts, only at process start — never
 * imported eagerly here, so this module stays testable without DATABASE_URL set.
 */
export function createApp(repo: Repository): Express {
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
      allowedHeaders: ["Content-Type", "x-operator-key"],
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

  app.use(createEvaluationsRouter(repo));
  app.use(createCredentialsRouter(repo));
  app.use(createEvaluationRequestsRouter(repo));

  return app;
}
