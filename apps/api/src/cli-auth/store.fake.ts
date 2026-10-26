/** In-memory CliAuthStore for the router tests. Same rules as store.pg.ts (its pg test proves those). */
import { SESSION_TTL_SECONDS } from "../auth/session.js";
import {
  CliAuthError,
  MIN_POLL_GAP_MS,
  codeState,
  notPendingError,
  type CliAuthStore,
  type CliCodeView,
  type CliSession,
  type CliSessionRecord,
  type NewDeviceCode,
  type PollOutcome,
} from "./store.js";

interface Row {
  deviceCodeSha256: string;
  userCode: string;
  clientName: string | null;
  principal: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  deniedAt: Date | null;
  consumedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  polledAt: Date | null;
  sessionId: string | null;
}

export class FakeCliAuthStore implements CliAuthStore {
  readonly rows = new Map<string, Row>();
  /** Set to make every call throw (a schema or a DB failure). */
  fail: Error | null = null;
  sessionLookups = 0;

  private check() {
    if (this.fail) throw this.fail;
  }

  private byUserCode(userCode: string): Row | undefined {
    return [...this.rows.values()].find((r) => r.userCode === userCode);
  }

  private view(r: Row, at: Date): CliCodeView {
    return { userCode: r.userCode, clientName: r.clientName, state: codeState(r, at), createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString() };
  }

  async create(code: NewDeviceCode, at: Date): Promise<void> {
    this.check();
    if (this.byUserCode(code.userCode)) throw new CliAuthError(409, "user_code_collision", "the user code is taken");
    this.rows.set(code.deviceCodeSha256, {
      deviceCodeSha256: code.deviceCodeSha256, userCode: code.userCode, clientName: code.clientName, principal: null, createdAt: at,
      approvedAt: null, deniedAt: null, consumedAt: null, revokedAt: null, expiresAt: code.expiresAt, polledAt: null, sessionId: null,
    });
  }

  async describe(userCode: string, at: Date): Promise<CliCodeView | null> {
    this.check();
    const r = this.byUserCode(userCode);
    return r ? this.view(r, at) : null;
  }

  private decide(userCode: string, at: Date, apply: (r: Row) => void): CliCodeView {
    this.check();
    const r = this.byUserCode(userCode);
    if (!r) throw new CliAuthError(404, "code_not_found", "no login request has this code");
    const state = codeState(r, at);
    if (state !== "pending") throw notPendingError(state);
    apply(r);
    return this.view(r, at);
  }

  async approve(userCode: string, principal: string, at: Date): Promise<CliCodeView> {
    return this.decide(userCode, at, (r) => {
      r.approvedAt = at;
      r.principal = principal;
    });
  }

  async deny(userCode: string, at: Date): Promise<CliCodeView> {
    return this.decide(userCode, at, (r) => {
      r.deniedAt = at;
    });
  }

  async poll(deviceCodeSha256: string, at: Date, sessionId: string): Promise<PollOutcome> {
    this.check();
    const r = this.rows.get(deviceCodeSha256);
    if (!r) return { kind: "unknown" };
    const state = codeState(r, at);
    if (state === "approved") {
      r.consumedAt = at;
      r.sessionId = sessionId;
      r.polledAt = at;
      return { kind: "approved", principal: r.principal!, sessionId };
    }
    if (state === "pending") {
      const prev = r.polledAt;
      r.polledAt = at;
      return prev && at.getTime() - prev.getTime() < MIN_POLL_GAP_MS ? { kind: "slow_down" } : { kind: "pending" };
    }
    if (state === "consumed") return { kind: "consumed" };
    if (state === "denied" || state === "revoked") return { kind: "denied" };
    return { kind: "expired" };
  }

  async listSessions(principal: string, at: Date): Promise<CliSession[]> {
    this.check();
    return [...this.rows.values()]
      .filter((r) => r.principal === principal && r.sessionId && r.consumedAt && r.consumedAt.getTime() > at.getTime() - SESSION_TTL_SECONDS * 1000)
      .sort((a, b) => b.consumedAt!.getTime() - a.consumedAt!.getTime())
      .map((r) => ({
        id: r.sessionId!,
        clientName: r.clientName,
        approvedAt: r.approvedAt!.toISOString(),
        createdAt: r.consumedAt!.toISOString(),
        expiresAt: new Date(r.consumedAt!.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
        revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
      }));
  }

  async revoke(principal: string, sessionId: string, at: Date): Promise<boolean> {
    this.check();
    const r = [...this.rows.values()].find((x) => x.principal === principal && x.sessionId === sessionId);
    if (!r) return false;
    r.revokedAt ??= at;
    return true;
  }

  async session(sessionId: string): Promise<CliSessionRecord | null> {
    this.check();
    this.sessionLookups++;
    const r = [...this.rows.values()].find((x) => x.sessionId === sessionId);
    return r ? { principal: r.principal!, revoked: r.revokedAt !== null } : null;
  }
}
