/**
 * CLI device login (plan 20261026-tma-local-runner-and-self-declared-results, §4 "How login works",
 * ADR-7; task L5). Needs db/migrations/0021_self_declared_results.sql (public.cli_device_codes).
 *
 *   start    the CLI asks for a code: a secret device code (only its sha256 is stored) and a short user
 *            code (ABCD-EFGH) that the user types or opens on the web2 page /cli. Expires after 600 s.
 *   approve  the user, signed in on web2 with Login with DFL, clicks Allow. One approval per code. The
 *            code is now bound to that principal. Deny closes the code.
 *   poll     the CLI polls with the device code: pending → approved (ONE time: the CLI gets a 24 h TMA
 *            session with a `sid` claim) → consumed. Expired and denied codes give no session.
 *   revoke   the owner lists his CLI sessions (GET /me/cli-sessions) and revokes one. The CLI session
 *            guard refuses a revoked `sid` on every route.
 *
 * Every method takes the clock as `at`, so a test can move time without a sleep.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";

export const CLI_AUTH_MIGRATION = "0021_self_declared_results.sql";
/** Lifetime of a device code (plan §4: expires_in 600). */
export const DEVICE_CODE_TTL_SECONDS = 600;
/** The poll interval that the CLI must keep (RFC 8628 `interval`). */
export const POLL_INTERVAL_SECONDS = 5;
/** A poll that comes sooner than this after the last one gets 429 slow_down (1 s of jitter allowed). */
export const MIN_POLL_GAP_MS = (POLL_INTERVAL_SECONDS - 1) * 1000;
export const CLIENT_NAME_MAX = 60;

/** No 0/O, 1/I/L: a user code is read from a terminal and typed by a human. */
export const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{43}$/;
/** The client name that the CLI sends: short, no newline, no quote mark (cli_device_codes_client_name_check). */
export const CLIENT_NAME_RE = /^[A-Za-z0-9 .,:;/()+_%$=&#-]{1,60}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CliAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type CliCodeState = "pending" | "approved" | "denied" | "consumed" | "revoked" | "expired";

/** What the approve page shows about a code. Never the device code, never a token. */
export interface CliCodeView {
  userCode: string;
  clientName: string | null;
  state: CliCodeState;
  createdAt: string;
  expiresAt: string;
}

export interface NewDeviceCode {
  deviceCodeSha256: string;
  userCode: string;
  clientName: string | null;
  expiresAt: Date;
}

export type PollOutcome =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "approved"; principal: string; sessionId: string }
  | { kind: "consumed" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "unknown" };

/** One CLI session of a principal (GET /me/cli-sessions). */
export interface CliSession {
  id: string;
  clientName: string | null;
  approvedAt: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface CliSessionRecord {
  principal: string;
  revoked: boolean;
}

export interface CliAuthStore {
  /** Inserts a new code. Throws CliAuthError 409 `user_code_collision` when the user code is taken (the
   * router retries with a new one). Also deletes the old rows (expired codes, sessions older than 2 days). */
  create(code: NewDeviceCode, at: Date): Promise<void>;
  /** The code by its user code, or null. */
  describe(userCode: string, at: Date): Promise<CliCodeView | null>;
  /** One approval per code. 404 code_not_found, 400 code_expired, 409 code_already_used. */
  approve(userCode: string, principal: string, at: Date): Promise<CliCodeView>;
  /** Closes a pending code. Same errors as approve. */
  deny(userCode: string, at: Date): Promise<CliCodeView>;
  /** The CLI poll. On `approved` the code is consumed in the same statement: a second poll is `consumed`. */
  poll(deviceCodeSha256: string, at: Date, sessionId: string): Promise<PollOutcome>;
  /** The CLI sessions of a principal that are not expired yet (revoked ones included, with revokedAt). */
  listSessions(principal: string, at: Date): Promise<CliSession[]>;
  /** Revokes one CLI session of the principal. False when the principal has no such session. */
  revoke(principal: string, sessionId: string, at: Date): Promise<boolean>;
  /** The session row behind a `sid` claim, or null when it does not exist (any more). */
  session(sessionId: string): Promise<CliSessionRecord | null>;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 32 random bytes, base64url (43 characters). The CLI keeps it; the DB keeps only its sha256. */
export function newDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

/** ABCD-EFGH from USER_CODE_ALPHABET (31^8 ≈ 8.5e11 codes). */
export function newUserCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Accepts `abcd efgh`, `ABCDEFGH`, `abcd-efgh`. Returns `ABCD-EFGH`, or null when it cannot be a user code. */
export function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 20) return null;
  const compact = raw.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z0-9]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** The state of a row at time `at`. Consumed and revoked win over the clock: they are final. */
export function codeState(row: {
  approvedAt: Date | null;
  deniedAt: Date | null;
  consumedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}, at: Date): CliCodeState {
  if (row.revokedAt) return "revoked";
  if (row.consumedAt) return "consumed";
  if (row.deniedAt) return "denied";
  if (row.expiresAt.getTime() <= at.getTime()) return "expired";
  if (row.approvedAt) return "approved";
  return "pending";
}

/** The error for an approve or deny of a code that is not pending. */
export function notPendingError(state: CliCodeState): CliAuthError {
  if (state === "expired") return new CliAuthError(400, "code_expired", "this code is expired: run tma login again");
  return new CliAuthError(409, "code_already_used", "this code was already approved or denied");
}
