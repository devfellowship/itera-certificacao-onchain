import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import { RATE_LIMIT } from "../config.js";
import { verifySessionToken } from "./auth.js";

/**
 * Rate limiting (two buckets per client, both in process memory).
 *
 * Key: the wallet of a valid session token, else the client IP. The IP is `req.ip`, which is the
 * real client address only because app.ts sets `trust proxy` to the exact number of proxies in
 * front of the API (see TRUST_PROXY_HOPS). Without it every client shares the proxy's address and
 * one bucket for the whole world.
 *
 * Two limiters:
 * - public cached GETs (`/public/*`, `/nft/*`, `/badge/*`, `/b/*`) use RATE_LIMIT.PUBLIC_MAX_REQUESTS;
 * - everything else uses RATE_LIMIT.MAX_REQUESTS.
 * `/health` is mounted before both in app.ts and is never limited.
 */

const PUBLIC_PREFIXES = ["/public/", "/nft/", "/badge/", "/b/"];

export function isPublicCachedRead(req: Pick<Request, "method" | "path">): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return PUBLIC_PREFIXES.some((prefix) => req.path.startsWith(prefix));
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((req.get("authorization") ?? "").trim());
  return match ? match[1]!.trim() : null;
}

/** `w:<wallet>` for a valid session, else `ip:<client ip>` (IPv6 grouped by /56 so one host cannot
 * rotate through its whole subnet). A forged or expired token falls back to the IP bucket. */
export function rateLimitKey(req: Request): string {
  const token = bearer(req);
  if (token) {
    try {
      const wallet = verifySessionToken(token);
      if (wallet) return `w:${wallet}`;
    } catch {
      // ITERA_SESSION_SECRET unset: no session can be valid, use the IP.
    }
  }
  return `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
}

export function createRateLimiters(): RequestHandler[] {
  const common = { windowMs: RATE_LIMIT.WINDOW_MS, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey } as const;
  return [
    rateLimit({ ...common, limit: RATE_LIMIT.PUBLIC_MAX_REQUESTS, skip: (req) => !isPublicCachedRead(req) }),
    rateLimit({ ...common, limit: RATE_LIMIT.MAX_REQUESTS, skip: (req) => isPublicCachedRead(req) }),
  ];
}
