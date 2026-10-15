import type { NextFunction, Request, Response } from "express";
import type { Principal } from "./adapters/types.js";
import { verifyPrincipalToken } from "./principal.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requirePrincipal` (or `optionalPrincipal`) — the authenticated caller. */
      principal?: Principal;
      /** Alias of `principal.id` (ADR-3): a base58 wallet address for `siws`, `dfl:<uuid>` for `dfl`. */
      wallet?: string;
    }
  }
}

function bearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

function readPrincipal(req: Request): Principal | null {
  const token = bearerToken(req);
  return token ? verifyPrincipalToken(token) : null;
}

/** Rejects with 401 unless the request carries a valid session; sets `req.principal` and `req.wallet`. */
export function requirePrincipal(req: Request, res: Response, next: NextFunction): void {
  const principal = readPrincipal(req);
  if (!principal) {
    res.status(401).json({ error: "a valid wallet session is required (Authorization: Bearer <token>)" });
    return;
  }
  req.principal = principal;
  req.wallet = principal.id;
  next();
}

/** Sets `req.principal` and `req.wallet` when a valid session is present; never rejects. For public
 * reads that show more to the owner. */
export function optionalPrincipal(req: Request, _res: Response, next: NextFunction): void {
  const principal = readPrincipal(req);
  if (principal) {
    req.principal = principal;
    req.wallet = principal.id;
  }
  next();
}

/** Alias kept so the existing routes do not change (ADR-3). */
export const requireWallet = requirePrincipal;
/** Alias kept so the existing routes do not change (ADR-3). */
export const optionalWallet = optionalPrincipal;
