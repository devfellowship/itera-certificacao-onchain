/**
 * `POST /models/access {openrouterKey}` (plan 20261015-testmyagent-web2-client, ADR-5, task T8).
 *
 * The "Check key" button of the web2 client. It probes the caller's OpenRouter key with
 * `GET https://openrouter.ai/api/v1/key` and answers:
 *   200 {label, limitRemaining, isFreeTier}
 *   422 model_key_required | model_key_invalid | model_key_no_credit
 *   503 model_key_probe_unavailable (with Retry-After)
 *
 * It never stores the key, and it never logs or echoes the key. Session required (any principal).
 */
import { Router } from "express";
import { requirePrincipal } from "../auth/middleware.js";
import { PROBE_RETRY_AFTER_S, probeKey, type ProbeKeyOptions } from "../models/openrouter-key.js";
import { isOpenRouterKey } from "../payments/adapters/free-byok.js";

export interface ModelsAccessRouterDeps {
  /** Probe options (a test injects `fetchFn`). */
  probe?: ProbeKeyOptions;
}

export function createModelsAccessRouter(deps: ModelsAccessRouterDeps = {}): Router {
  const router = Router();
  router.post("/models/access", requirePrincipal, (req, res, next) => {
    const key = (req.body ?? {}).openrouterKey as unknown;
    if (key === undefined || key === null || key === "") {
      res.status(422).json({ error: "openrouterKey is required", code: "model_key_required" });
      return;
    }
    if (!isOpenRouterKey(key)) {
      res.status(422).json({ error: "openrouterKey is not a valid OpenRouter API key (sk-or-…)", code: "model_key_invalid" });
      return;
    }
    probeKey(key.trim(), deps.probe)
      .then((r) => {
        switch (r.status) {
          case "valid":
            res.json({ label: r.info.label, limitRemaining: r.info.limitRemaining, isFreeTier: r.info.isFreeTier });
            return;
          case "invalid":
            res.status(422).json({ error: "OpenRouter refused this API key", code: "model_key_invalid" });
            return;
          case "no_credit":
            res.status(422).json({ error: "this OpenRouter API key has no credit left", code: "model_key_no_credit", label: r.info.label, limitRemaining: 0, isFreeTier: r.info.isFreeTier });
            return;
          case "unavailable":
            res.set("Retry-After", String(PROBE_RETRY_AFTER_S));
            res.status(503).json({ error: "cannot reach OpenRouter to check the API key; try again", code: "model_key_probe_unavailable" });
            return;
        }
      })
      .catch(next);
  });
  return router;
}
