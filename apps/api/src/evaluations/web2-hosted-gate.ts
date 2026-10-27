/**
 * "web2 = ingested only for now" (Tainan TG 23889; plan 20261026-tma-local-runner-and-self-declared-results,
 * task L15a). A Login with DFL session (principal kind `dfl`) does not get a hosted run: the user runs the
 * task on their own machine with the `tma` local runner and sends the numbers to `POST /self-declared-results`.
 * A web3 session (kind `siws`: wallet, Solana Pay) is not affected.
 *
 * The gate answers `403 hosted_not_available_web2` on the three hosted start routes of evaluations/router.ts
 * (`POST /evaluations/quote`, `POST /evaluations/quote/:reference/transaction`, `POST /evaluations`). It runs
 * AFTER `requireWallet` (an anonymous caller still gets 401) and BEFORE any store read, any model-key probe
 * and any payment adapter call, so a refused request writes nothing and reads no key.
 *
 * The reads (`GET /evaluations`, `GET /evaluations/:id`) and the cancel stay open: old hosted evaluations and
 * self-declared ones live there.
 *
 * Env flag — the "for now" switch:
 *   `TMA_WEB2_HOSTED_ENABLED` (default false). Only the exact value `true` (trimmed, lower case) turns the
 *   hosted `dfl` path (the free BYOK adapter, payments/adapters/free-byok.ts) back on, with no code change.
 */
import type { RequestHandler } from "express";

export const HOSTED_NOT_AVAILABLE_WEB2_CODE = "hosted_not_available_web2";

/** The `tma` commands of services/runner/src/cli (login, run, upload) with their real flags. */
export const LOCAL_RUNNER_STEPS = [
  "tma login",
  "tma run --task <task slug> --agent <agent id> --agent-dir <agent dir> --model <model id> --out result.json",
  "tma upload result.json",
] as const;

export const SELF_DECLARED_ROUTE = "POST /self-declared-results";

export const HOSTED_NOT_AVAILABLE_WEB2_MESSAGE =
  "Hosted runs are not available for a Login with DFL session. Run the task on your machine with the tma local runner, then send the result to POST /self-declared-results.";

export interface HostedNotAvailableWeb2Body {
  error: typeof HOSTED_NOT_AVAILABLE_WEB2_CODE;
  message: string;
  localRunner: { steps: string[]; newLocalAgentUrl: string };
  selfDeclared: typeof SELF_DECLARED_ROUTE;
}

/** The 403 body. `web2BaseUrl` is the base of the web2 client (trailing slashes are dropped). */
export function hostedNotAvailableWeb2Body(web2BaseUrl: string): HostedNotAvailableWeb2Body {
  const base = web2BaseUrl.replace(/\/+$/, "");
  return {
    error: HOSTED_NOT_AVAILABLE_WEB2_CODE,
    message: HOSTED_NOT_AVAILABLE_WEB2_MESSAGE,
    localRunner: {
      steps: [...LOCAL_RUNNER_STEPS],
      newLocalAgentUrl: `${base}/agents/new?source=local`,
    },
    selfDeclared: SELF_DECLARED_ROUTE,
  };
}

/** `TMA_WEB2_HOSTED_ENABLED`: only the exact value `true` (trimmed, lower case) turns the hosted dfl path on. */
export function web2HostedEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TMA_WEB2_HOSTED_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * Refuses a `dfl` principal with `403 hosted_not_available_web2` unless `enabled`. Any other principal
 * (or no principal: `requireWallet` runs first) passes through.
 */
export function refuseHostedForDfl(opts: { enabled: boolean; web2BaseUrl: string }): RequestHandler {
  const body = hostedNotAvailableWeb2Body(opts.web2BaseUrl);
  return (req, res, next) => {
    if (!opts.enabled && req.principal?.kind === "dfl") {
      res.status(403).json(body);
      return;
    }
    next();
  };
}
