import { createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import { getBase58Encoder, isAddress } from "@solana/kit";
import { Router } from "express";
import { issueSessionToken } from "../session.js";
import type { AuthAdapter, Principal } from "./types.js";

/**
 * Sign-In With Solana (web3 client). Moved unchanged from `http/auth.ts`
 * (contract "Identity", plan 20261012-itera-agent-proof-route-change-fixes).
 *
 * - The wallet address (base58) IS the principal id.
 * - `POST /auth/nonce {wallet}` returns a message with a single-use server nonce (5 min TTL, in
 *   memory). The wallet signs the message bytes (ed25519, `signMessage`), then
 *   `POST /auth/verify {wallet, signature}` checks the signature and returns a session token
 *   (`amr: "siws"`).
 *
 * Nonces live in process memory. One API replica is deployed, so this is enough for the demo;
 * a restart only invalidates sign-ins that are in progress, never live sessions (those are
 * stateless JWTs).
 */

export const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_NONCES = 10_000;
const SIWS_DOMAIN = "itera-agent-credentials.devfellowship.com";

interface PendingNonce {
  nonce: string;
  message: string;
  expiresAtMs: number;
}

/** Latest pending nonce per wallet. A new `/auth/nonce` call for the same wallet replaces it. */
const pendingNonces = new Map<string, PendingNonce>();

function sweepExpired(nowMs: number): void {
  for (const [wallet, entry] of pendingNonces) {
    if (entry.expiresAtMs <= nowMs) pendingNonces.delete(wallet);
  }
}

export function buildSignInMessage(wallet: string, nonce: string, issuedAt: string, expiresAt: string): string {
  return [
    `${SIWS_DOMAIN} wants you to sign in with your Solana account:`,
    wallet,
    "",
    "Sign in to TestMyAgent. This request does not send a transaction and costs nothing.",
    "",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join("\n");
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Signature may be base58 (Solana convention) or base64. Returns null when neither decodes to 64 bytes. */
function decodeSignature(signature: string): Buffer | null {
  if (BASE58_RE.test(signature)) {
    try {
      const bytes = Buffer.from(getBase58Encoder().encode(signature));
      if (bytes.length === 64) return bytes;
    } catch {
      // fall through to base64
    }
  }
  const b64 = Buffer.from(signature, "base64");
  return b64.length === 64 ? b64 : null;
}

export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  const sig = decodeSignature(signature);
  if (!sig) return false;
  const publicKeyBytes = Buffer.from(getBase58Encoder().encode(wallet));
  if (publicKeyBytes.length !== 32) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

/** POST /auth/nonce · POST /auth/verify */
function createSiwsRouter(): Router {
  const router = Router();

  router.post("/auth/nonce", (req, res) => {
    const wallet = (req.body as { wallet?: unknown } | undefined)?.wallet;
    if (typeof wallet !== "string" || !isAddress(wallet)) {
      res.status(400).json({ error: "wallet must be a base58 Solana address" });
      return;
    }
    const now = Date.now();
    sweepExpired(now);
    if (pendingNonces.size >= MAX_PENDING_NONCES && !pendingNonces.has(wallet)) {
      res.status(503).json({ error: "too many pending sign-ins, try again shortly" });
      return;
    }
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + NONCE_TTL_MS).toISOString();
    const message = buildSignInMessage(wallet, nonce, issuedAt, expiresAt);
    pendingNonces.set(wallet, { nonce, message, expiresAtMs: now + NONCE_TTL_MS });
    res.json({ nonce, message, expiresAt });
  });

  router.post("/auth/verify", (req, res) => {
    const body = (req.body ?? {}) as { wallet?: unknown; signature?: unknown };
    if (typeof body.wallet !== "string" || !isAddress(body.wallet) || typeof body.signature !== "string") {
      res.status(400).json({ error: "wallet (base58 address) and signature (base58 or base64) are required" });
      return;
    }
    const pending = pendingNonces.get(body.wallet);
    // Single-use: the nonce is consumed whether or not the signature is valid.
    pendingNonces.delete(body.wallet);
    if (!pending || pending.expiresAtMs <= Date.now()) {
      res.status(401).json({ error: "no valid nonce for this wallet — call POST /auth/nonce first" });
      return;
    }
    if (!verifyWalletSignature(body.wallet, pending.message, body.signature)) {
      res.status(401).json({ error: "signature does not match the sign-in message for this wallet" });
      return;
    }
    const { token, expiresAt } = issueSessionToken(body.wallet, Date.now(), "siws");
    res.json({ token, wallet: body.wallet, expiresAt });
  });

  return router;
}

export function isSiwsPrincipalId(value: string): boolean {
  return isAddress(value);
}

export const siwsAdapter: AuthAdapter = {
  kind: "siws",
  router: createSiwsRouter,
  principalFromSubject(sub: string): Principal | null {
    return isSiwsPrincipalId(sub) ? { id: sub, kind: "siws" } : null;
  },
};

/** Test-only: drops every pending nonce. */
export function resetPendingNoncesForTests(): void {
  pendingNonces.clear();
}
