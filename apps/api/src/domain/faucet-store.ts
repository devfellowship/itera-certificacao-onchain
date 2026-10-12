/**
 * Devnet faucet grants (U37, plan 20261012-itera-testmyagent-ui-refactor). Table faucet_grants
 * (db/migrations/0016_sample_repos_faucet.sql). A grant is reserved (`pending`) before the transfer
 * and closed as `sent` or `failed` after it. `pending` and `sent` grants count toward both limits:
 * one grant per wallet per window, and a global cap of lamports per window.
 */
import { randomUUID } from "node:crypto";

export const FAUCET_MIGRATION = "0016_sample_repos_faucet.sql";

export type FaucetGrantStatus = "pending" | "sent" | "failed";

export interface FaucetGrant {
  id: string;
  wallet: string;
  lamports: number;
  status: FaucetGrantStatus;
  txSig: string | null;
  error: string | null;
  createdAt: string;
}

export type ReserveResult =
  | { ok: true; grant: FaucetGrant }
  | { ok: false; reason: "wallet_recent"; nextAt: string }
  | { ok: false; reason: "daily_cap" };

export interface FaucetStore {
  /** Atomic: checks both limits and inserts a `pending` grant, or refuses. */
  reserve(input: { wallet: string; lamports: number; windowMs: number; capLamports: number; now?: Date }): Promise<ReserveResult>;
  complete(id: string, txSig: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  /** The latest grant of this wallet that counts (pending or sent), or null. */
  lastGrant(wallet: string): Promise<FaucetGrant | null>;
}

export class FakeFaucetStore implements FaucetStore {
  grants: FaucetGrant[] = [];

  async reserve(input: { wallet: string; lamports: number; windowMs: number; capLamports: number; now?: Date }): Promise<ReserveResult> {
    const now = input.now ?? new Date();
    const since = now.getTime() - input.windowMs;
    const live = this.grants.filter((g) => g.status !== "failed" && Date.parse(g.createdAt) > since);
    const mine = live.filter((g) => g.wallet === input.wallet).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (mine) return { ok: false, reason: "wallet_recent", nextAt: new Date(Date.parse(mine.createdAt) + input.windowMs).toISOString() };
    const used = live.reduce((s, g) => s + g.lamports, 0);
    if (used + input.lamports > input.capLamports) return { ok: false, reason: "daily_cap" };
    const grant: FaucetGrant = { id: randomUUID(), wallet: input.wallet, lamports: input.lamports, status: "pending", txSig: null, error: null, createdAt: now.toISOString() };
    this.grants.push(grant);
    return { ok: true, grant };
  }

  async complete(id: string, txSig: string) {
    const g = this.grants.find((x) => x.id === id);
    if (g) Object.assign(g, { status: "sent", txSig });
  }

  async fail(id: string, error: string) {
    const g = this.grants.find((x) => x.id === id);
    if (g) Object.assign(g, { status: "failed", error });
  }

  async lastGrant(wallet: string) {
    return this.grants.filter((g) => g.wallet === wallet && g.status !== "failed").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }
}
