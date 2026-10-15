import type { Router } from "express";

/**
 * Auth adapter seam (plan 20261015-testmyagent-web2-client, ADR-3).
 *
 * A principal is the owner id of every row the API writes. Two kinds exist:
 * - `siws`: a base58 Solana address (web3 client, Sign-In With Solana);
 * - `dfl`: `dfl:<uuid>` (web2 client, Login with DFL).
 * A colon never appears in base58, so the two kinds cannot collide.
 */
export type PrincipalKind = "siws" | "dfl";

export interface Principal {
  id: string;
  kind: PrincipalKind;
}

export interface AuthAdapter {
  readonly kind: PrincipalKind;
  /** The login routes of this adapter (mounted at the app root). */
  router(): Router;
  /** Returns the principal for a session `sub` of this kind, or null when the value is not valid for it. */
  principalFromSubject(sub: string): Principal | null;
}
