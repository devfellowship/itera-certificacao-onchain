import { Router, type Response } from "express";

/**
 * Retired vendor-endpoint flow (410 Gone).
 *
 * The first flow had a vendor register an HTTPS endpoint, then `POST /evaluations/:id/dispatch`
 * called it and graded the returned patch as a LOCAL process inside the API container. That ran
 * the evaluator, and the vendor's patch, outside the grader sandbox. Evaluations v2
 * (evaluations/router.ts: quote, Solana Pay, a batch of runs) plus the runner replaced it: the
 * runner runs the agent, and a separate no-network container runs the grader.
 *
 * These routes stay mounted only to answer 410 with a pointer, so an old client gets a clear
 * answer instead of a 404 or a silent success. Nothing here reads the database or runs a process.
 */
export const RETIRED_ROUTES = [
  "POST /evaluations (body with idempotencyKey)",
  "POST /evaluations/:id/dispatch",
  "GET /evaluations/:id/events",
  "POST /evaluations/:id/publish",
  "POST /agent-endpoint-manifests",
] as const;

export const REPLACEMENT_FLOW = {
  quote: "POST /evaluations/quote",
  transaction: "POST /evaluations/quote/:reference/transaction",
  create: "POST /evaluations (body: reference, txSig)",
  list: "GET /evaluations",
  detail: "GET /evaluations/:id",
  publicProfile: "GET /public/evaluations/:slugOrHash",
} as const;

function gone(res: Response): void {
  res.status(410).json({
    error: "gone",
    code: "legacy_flow_retired",
    message:
      "The vendor-endpoint flow is retired. Evaluations now run in the grader sandbox: request a quote, pay, and the runner evaluates the agent from its GitHub repo.",
    replacement: REPLACEMENT_FLOW,
  });
}

export function createLegacyGoneRouter(): Router {
  const router = Router();
  // When evaluations v2 is mounted it handles POST /evaluations first and falls through to here
  // only for a legacy body. Without v2 wired, this still answers 410 instead of running anything.
  router.post("/evaluations", (_req, res) => gone(res));
  router.post("/evaluations/:id/dispatch", (_req, res) => gone(res));
  router.get("/evaluations/:id/events", (_req, res) => gone(res));
  router.post("/evaluations/:id/publish", (_req, res) => gone(res));
  router.post("/agent-endpoint-manifests", (_req, res) => gone(res));
  return router;
}
