/**
 * Compatibility entry point. The auth code lives in `src/auth/` behind the auth adapter seam
 * (plan 20261015-testmyagent-web2-client, ADR-3):
 * - `auth/adapters/siws.ts` — Sign-In With Solana (`POST /auth/nonce`, `POST /auth/verify`);
 * - `auth/adapters/dfl.ts` — Login with DFL (`POST /auth/dfl/exchange`);
 * - `auth/session.ts` — session JWT (`amr` claim);
 * - `auth/principal.ts` — token → `Principal`;
 * - `auth/middleware.ts` — `requirePrincipal` / `optionalPrincipal` (+ `requireWallet` /
 *   `optionalWallet` aliases).
 * Existing routes keep importing from here.
 */
export { NONCE_TTL_MS, buildSignInMessage, resetPendingNoncesForTests, verifyWalletSignature } from "../auth/adapters/siws.js";
export type { AuthAdapter, Principal, PrincipalKind } from "../auth/adapters/types.js";
export { optionalPrincipal, optionalWallet, requirePrincipal, requireWallet } from "../auth/middleware.js";
export { verifyPrincipalToken, verifySessionToken } from "../auth/principal.js";
export { createAuthRouter, type AuthRouterOptions } from "../auth/router.js";
export { SESSION_TTL_SECONDS, issueSessionToken } from "../auth/session.js";
