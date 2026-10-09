import express, { type Express } from "express";

export const SERVICE_NAME = "itera-agent-credentials-api";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      status: "ok",
      routes: ["/", "/hello-world"],
    });
  });

  app.get("/hello-world", (_req, res) => {
    res.type("text/plain").send("Hello, world!");
  });

  return app;
}
