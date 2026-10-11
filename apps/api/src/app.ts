import cors from "cors";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import { CORS_ALLOWED_ORIGINS, RATE_LIMIT } from "./config.js";

export const SERVICE_NAME = "itera-agent-credentials-api";
export const API_VERSION = "0.2.0";

export function createApp(): Express {
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

  app.get("/", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      status: "ok",
      version: API_VERSION,
      routes: ["/", "/health", "/hello-world"],
    });
  });

  app.get("/hello-world", (_req, res) => {
    res.type("text/plain").send("Hello, world!");
  });

  return app;
}
