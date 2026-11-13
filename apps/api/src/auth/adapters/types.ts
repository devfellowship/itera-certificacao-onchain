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

/**
 * Who stands behind the session (plan 20261112-tma-c8-routing-from-evals, Q b5c4ba38 = B): the `act` claim of the
 * TMA session. `human` only when POST /auth/dfl/exchange proved a DFL human actor for the token; `agent` for a DFL
 * agent login; `unknown` for everything else (siws, CLI device sessions, tokens minted before the claim, an MCP OAuth
 * grant token, a failed lookup). Only `human` may approve a route or a route swap (fail closed).
 */
export type ActorType = "human" | "agent" | "unknown";
export const ACTOR_TYPES: readonly ActorType[] = ["human", "agent", "unknown"];

export interface Principal {
  id: string;
  kind: PrincipalKind;
  actorType: ActorType;
}

export interface AuthAdapter {
  readonly kind: PrincipalKind;
  /** The login routes of this adapter (mounted at the app root). */
  router(): Router;
  /** Returns the principal for a session `sub` of this kind, or null when the value is not valid for it. `actorType`
   * is the session's `act` claim (default `unknown`); an adapter may narrow it (siws is always `unknown`). */
  principalFromSubject(sub: string, actorType?: ActorType): Principal | null;
}
