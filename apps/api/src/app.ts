import express, { type Express } from "express";

export const SERVICE_NAME = "itera-agent-credentials-api";
export const API_VERSION = "0.2.0";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      status: "ok",
      version: API_VERSION,
      routes: ["/", "/hello-world"],
    });
  });

  app.get("/hello-world", (_req, res) => {
    res.type("text/plain").send("Hello, world!");
  });

  return app;
}
