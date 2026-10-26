/**
 * CLI device login routes (plan 20261026-tma-local-runner-and-self-declared-results, §4, ADR-7; task L5).
 *
 *   POST   /auth/cli/start               no auth. {client_name?} → {device_code, user_code, verification_url,
 *                                        interval, expires_in}. 10 per 10 min per IP.
 *   GET    /auth/cli/requests/:userCode  web session (dfl). What the approve page shows: client name, state.
 *   POST   /auth/cli/approve             web session (dfl). {user_code} → one approval per code.
 *   POST   /auth/cli/deny                web session (dfl). {user_code} → the code gives no session.
 *   POST   /auth/cli/token               no auth. {device_code} → 428 authorization_pending | 429 slow_down |
 *                                        200 {sessionToken, expiresAt, sessionId} ONE time | 400 code_consumed |
 *                                        400 access_denied | 400 code_expired | 400 invalid_device_code.
 *   GET    /me/cli-sessions              any session. The caller's CLI sessions that are not expired.
 *   DELETE /me/cli-sessions/:id          any session. Revokes one; the guard refuses its token at once.
 *
 * The CLI session is a 24 h TMA session of the approving principal (`amr = dfl`) with a `sid` claim. A
 * CLI session cannot approve another code: a login is always a human on web2, so a CLI token cannot
 * extend itself past 24 h. The approve, deny and requests routes take 30 calls per 10 min per principal
 * (a user code has 31^8 values; this keeps a guess at about zero).
 * Before 0021 every route answers 503 schema_not_ready.
 */
import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requirePrincipal } from "../auth/middleware.js";
import { issueSessionToken, verifySessionClaims } from "../auth/session.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { DEFAULT_WEB2_BASE_URL } from "../self-declared/router.js";
import type { CliSessionGuard } from "./guard.js";
import {
  CLIENT_NAME_RE,
  CliAuthError,
  DEVICE_CODE_RE,
  DEVICE_CODE_TTL_SECONDS,
  POLL_INTERVAL_SECONDS,
  UUID_RE,
  newDeviceCode,
  newUserCode,
  normalizeUserCode,
  sha256Hex,
  type CliAuthStore,
} from "./store.js";

const LIMIT_WINDOW_MS = 10 * 60 * 1000;

export interface CliAuthRouterDeps {
  store: CliAuthStore;
  /** Base URL of the web2 client: the approve page is `<base>/cli?code=<user code>`. */
  web2BaseUrl?: string;
  /** The guard of app.ts, so a revoke takes effect at once in this process. */
  guard?: CliSessionGuard;
  /** Test seams. */
  now?: () => number;
  startPerWindow?: number;
  decidePerWindow?: number;
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((req.get("authorization") ?? "").trim());
  return match ? match[1]!.trim() : null;
}

/** The `sid` of the request's session, or null for a web session. */
function sessionIdOf(req: Request): string | null {
  const token = bearer(req);
  if (!token) return null;
  try {
    return verifySessionClaims(token)?.sid ?? null;
  } catch {
    return null;
  }
}

function fail(res: Response, next: NextFunction, e: unknown) {
  if (e instanceof CliAuthError) res.status(e.status).json({ error: e.code, message: e.message });
  else if (e instanceof SchemaNotReadyError) res.status(503).json({ error: "schema_not_ready", message: e.message });
  else next(e);
}

export function createCliAuthRouter(deps: CliAuthRouterDeps): Router {
  const router = Router();
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const web2 = (deps.web2BaseUrl ?? DEFAULT_WEB2_BASE_URL).replace(/\/+$/, "");

  const limited = (limit: number, key: (req: Request) => string) =>
    rateLimit({
      windowMs: LIMIT_WINDOW_MS,
      limit,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: key,
      handler: (_req, res) => {
        res.status(429).json({ error: "rate_limited", message: "too many login requests: wait and try again" });
      },
    });
  const startLimit = limited(deps.startPerWindow ?? 10, (req) => `cli-start:${ipKeyGenerator(req.ip ?? "unknown")}`);
  const decideLimit = limited(deps.decidePerWindow ?? 30, (req) => `cli-decide:${req.principal?.id ?? ipKeyGenerator(req.ip ?? "unknown")}`);

  /** A human on web2: a dfl principal with a web session (no `sid`). */
  const webDflOnly = (req: Request, res: Response, next: NextFunction) => {
    if (req.principal?.kind !== "dfl") {
      res.status(403).json({ error: "cli_login_dfl_only", message: "the CLI login takes a Login with DFL session" });
      return;
    }
    if (sessionIdOf(req)) {
      res.status(403).json({ error: "cli_session_cannot_approve", message: "approve a CLI login on the web page, not from a CLI session" });
      return;
    }
    next();
  };

  const userCodeOf = (raw: unknown, res: Response): string | null => {
    const code = normalizeUserCode(raw);
    if (!code) res.status(400).json({ error: "invalid_user_code", message: "user_code is 8 letters or digits, as ABCD-EFGH" });
    return code;
  };

  router.post("/auth/cli/start", startLimit, async (req, res, next) => {
    const raw = (req.body as { client_name?: unknown } | undefined)?.client_name;
    if (raw !== undefined && raw !== null && (typeof raw !== "string" || !CLIENT_NAME_RE.test(raw))) {
      res.status(400).json({ error: "invalid_client_name", message: "client_name: 1 to 60 characters, no newline and no quote mark" });
      return;
    }
    const clientName = typeof raw === "string" ? raw : null;
    const deviceCode = newDeviceCode();
    const at = new Date(now());
    const expiresAt = new Date(at.getTime() + DEVICE_CODE_TTL_SECONDS * 1000);
    try {
      for (let attempt = 0; ; attempt++) {
        const userCode = newUserCode();
        try {
          await store.create({ deviceCodeSha256: sha256Hex(deviceCode), userCode, clientName, expiresAt }, at);
          res.status(200).json({
            device_code: deviceCode,
            user_code: userCode,
            verification_url: `${web2}/cli?code=${userCode}`,
            interval: POLL_INTERVAL_SECONDS,
            expires_in: DEVICE_CODE_TTL_SECONDS,
            expires_at: expiresAt.toISOString(),
          });
          return;
        } catch (e) {
          if (!(e instanceof CliAuthError && e.code === "user_code_collision") || attempt >= 4) throw e;
        }
      }
    } catch (e) {
      fail(res, next, e);
    }
  });

  router.get("/auth/cli/requests/:userCode", requirePrincipal, webDflOnly, decideLimit, async (req, res, next) => {
    const code = userCodeOf(req.params.userCode, res);
    if (!code) return;
    try {
      const view = await store.describe(code, new Date(now()));
      if (!view) {
        res.status(404).json({ error: "code_not_found", message: "no login request has this code" });
        return;
      }
      res.json({ user_code: view.userCode, client_name: view.clientName, state: view.state, created_at: view.createdAt, expires_at: view.expiresAt });
    } catch (e) {
      fail(res, next, e);
    }
  });

  for (const action of ["approve", "deny"] as const) {
    router.post(`/auth/cli/${action}`, requirePrincipal, webDflOnly, decideLimit, async (req, res, next) => {
      const code = userCodeOf((req.body as { user_code?: unknown } | undefined)?.user_code, res);
      if (!code) return;
      try {
        const at = new Date(now());
        const view = action === "approve" ? await store.approve(code, req.principal!.id, at) : await store.deny(code, at);
        res.json({ user_code: view.userCode, client_name: view.clientName, state: view.state });
      } catch (e) {
        fail(res, next, e);
      }
    });
  }

  router.post("/auth/cli/token", async (req, res, next) => {
    const deviceCode = (req.body as { device_code?: unknown } | undefined)?.device_code;
    if (typeof deviceCode !== "string" || !DEVICE_CODE_RE.test(deviceCode)) {
      res.status(400).json({ error: "invalid_device_code", message: "device_code is the value that POST /auth/cli/start returned" });
      return;
    }
    try {
      const atMs = now();
      const outcome = await store.poll(sha256Hex(deviceCode), new Date(atMs), randomUUID());
      switch (outcome.kind) {
        case "approved": {
          const { token, expiresAt } = issueSessionToken(outcome.principal, atMs, "dfl", outcome.sessionId);
          res.setHeader("Cache-Control", "no-store");
          res.status(200).json({ sessionToken: token, expiresAt, sessionId: outcome.sessionId, principal: outcome.principal });
          return;
        }
        case "pending":
          res.status(428).json({ error: "authorization_pending", interval: POLL_INTERVAL_SECONDS });
          return;
        case "slow_down":
          res.status(429).json({ error: "slow_down", interval: POLL_INTERVAL_SECONDS });
          return;
        case "consumed":
          res.status(400).json({ error: "code_consumed", message: "this code already gave a session" });
          return;
        case "denied":
          res.status(400).json({ error: "access_denied", message: "the login was denied on the web page" });
          return;
        case "expired":
          res.status(400).json({ error: "code_expired", message: "this code is expired: run tma login again" });
          return;
        default:
          res.status(400).json({ error: "invalid_device_code", message: "no login request has this device code" });
      }
    } catch (e) {
      fail(res, next, e);
    }
  });

  router.get("/me/cli-sessions", requirePrincipal, async (req, res, next) => {
    try {
      const sessions = await store.listSessions(req.principal!.id, new Date(now()));
      const current = sessionIdOf(req);
      res.json({
        sessions: sessions.map((s) => ({
          id: s.id,
          client_name: s.clientName,
          approved_at: s.approvedAt,
          created_at: s.createdAt,
          expires_at: s.expiresAt,
          revoked_at: s.revokedAt,
          current: s.id === current,
        })),
      });
    } catch (e) {
      fail(res, next, e);
    }
  });

  router.delete("/me/cli-sessions/:id", requirePrincipal, async (req, res, next) => {
    const id = String(req.params.id).toLowerCase();
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "cli_session_not_found" });
      return;
    }
    try {
      const done = await store.revoke(req.principal!.id, id, new Date(now()));
      if (!done) {
        res.status(404).json({ error: "cli_session_not_found" });
        return;
      }
      deps.guard?.forget(id);
      res.status(204).end();
    } catch (e) {
      fail(res, next, e);
    }
  });

  return router;
}
