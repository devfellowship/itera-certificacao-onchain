/**
 * Postgres store of the CLI device login (task L5). Needs 0021 (public.cli_device_codes with the L5
 * columns): before it, a statement fails with 42P01 / 42703 and the store throws SchemaNotReadyError (the
 * router answers 503 schema_not_ready).
 *
 * Every state change is ONE conditional UPDATE, so two concurrent approvals or two concurrent polls
 * cannot both win: the loser sees 0 rows and reads the row again to tell why.
 */
import type { Pool } from "pg";
import { SESSION_TTL_SECONDS } from "../auth/session.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import {
  CLI_AUTH_MIGRATION,
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

function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}
function pgConstraint(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "constraint" in e ? String((e as { constraint: unknown }).constraint) : undefined;
}
function rethrow(e: unknown): never {
  const code = pgCode(e);
  if (code === "42703" || code === "42P01") throw new SchemaNotReadyError(CLI_AUTH_MIGRATION, e);
  throw e;
}
const date = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const iso = (v: unknown) => date(v)!.toISOString();

type Row = Record<string, unknown>;

function rowState(r: Row, at: Date) {
  return codeState(
    {
      approvedAt: date(r.approved_at),
      deniedAt: date(r.denied_at),
      consumedAt: date(r.consumed_at),
      revokedAt: date(r.revoked_at),
      expiresAt: date(r.expires_at)!,
    },
    at,
  );
}

function toView(r: Row, at: Date): CliCodeView {
  return {
    userCode: String(r.user_code),
    clientName: (r.client_name as string | null) ?? null,
    state: rowState(r, at),
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
  };
}

const COLUMNS = `user_code, client_name, principal, created_at, approved_at, denied_at, consumed_at, revoked_at, expires_at, polled_at, session_id`;

export class PgCliAuthStore implements CliAuthStore {
  constructor(private readonly pool: () => Pool) {}

  async create(code: NewDeviceCode, at: Date): Promise<void> {
    try {
      // Housekeeping first: codes that expired an hour ago, and sessions older than 2 days (their 24 h
      // token is expired, so the row is no longer needed for revocation).
      await this.pool().query(
        `delete from public.cli_device_codes
          where (consumed_at is null and expires_at < $1::timestamptz - interval '1 hour')
             or consumed_at < $1::timestamptz - interval '2 days'`,
        [at],
      );
      await this.pool().query(
        `insert into public.cli_device_codes (device_code_sha256, user_code, client_name, created_at, expires_at)
         values ($1, $2, $3, $4, $5)`,
        [code.deviceCodeSha256, code.userCode, code.clientName, at, code.expiresAt],
      );
    } catch (e) {
      if (pgCode(e) === "23505" && pgConstraint(e) === "cli_device_codes_user_code_key") {
        throw new CliAuthError(409, "user_code_collision", "the user code is taken");
      }
      rethrow(e);
    }
  }

  async describe(userCode: string, at: Date): Promise<CliCodeView | null> {
    try {
      const { rows } = await this.pool().query(`select ${COLUMNS} from public.cli_device_codes where user_code = $1`, [userCode]);
      return rows[0] ? toView(rows[0], at) : null;
    } catch (e) {
      rethrow(e);
    }
  }

  private async decide(userCode: string, at: Date, set: string, values: unknown[]): Promise<CliCodeView> {
    try {
      const { rows } = await this.pool().query(
        `update public.cli_device_codes set ${set}
          where user_code = $1 and approved_at is null and denied_at is null and consumed_at is null and expires_at > $2
          returning ${COLUMNS}`,
        [userCode, at, ...values],
      );
      if (rows[0]) return toView(rows[0], at);
    } catch (e) {
      rethrow(e);
    }
    const now = await this.describe(userCode, at);
    if (!now) throw new CliAuthError(404, "code_not_found", "no login request has this code");
    throw notPendingError(now.state);
  }

  approve(userCode: string, principal: string, at: Date): Promise<CliCodeView> {
    return this.decide(userCode, at, `approved_at = $2, principal = $3`, [principal]);
  }

  deny(userCode: string, at: Date): Promise<CliCodeView> {
    return this.decide(userCode, at, `denied_at = $2`, []);
  }

  async poll(deviceCodeSha256: string, at: Date, sessionId: string): Promise<PollOutcome> {
    const pool = this.pool();
    try {
      // 1. The one-time consumption: approved, not consumed, not revoked, not expired.
      const taken = await pool.query(
        `update public.cli_device_codes
            set consumed_at = $2, session_id = $3, polled_at = $2
          where device_code_sha256 = $1 and approved_at is not null and consumed_at is null
            and revoked_at is null and expires_at > $2
          returning principal`,
        [deviceCodeSha256, at, sessionId],
      );
      if (taken.rows[0]) return { kind: "approved", principal: String(taken.rows[0].principal), sessionId };

      // 2. Still pending: record the poll, and tell a client that polls too fast to slow down.
      const pending = await pool.query(
        `with prev as (
           select device_code_sha256, polled_at from public.cli_device_codes
            where device_code_sha256 = $1 and approved_at is null and denied_at is null and expires_at > $2
            for update
         )
         update public.cli_device_codes c set polled_at = $2
           from prev where c.device_code_sha256 = prev.device_code_sha256
         returning prev.polled_at as prev_polled_at`,
        [deviceCodeSha256, at],
      );
      if (pending.rows[0]) {
        const prev = date(pending.rows[0].prev_polled_at);
        return prev && at.getTime() - prev.getTime() < MIN_POLL_GAP_MS ? { kind: "slow_down" } : { kind: "pending" };
      }

      // 3. A final state: tell which one.
      const { rows } = await pool.query(`select ${COLUMNS} from public.cli_device_codes where device_code_sha256 = $1`, [deviceCodeSha256]);
      if (!rows[0]) return { kind: "unknown" };
      const state = rowState(rows[0], at);
      if (state === "consumed") return { kind: "consumed" };
      // A code that was approved and then revoked before the CLI took it gives no session.
      if (state === "denied" || state === "revoked") return { kind: "denied" };
      return { kind: "expired" };
    } catch (e) {
      rethrow(e);
    }
  }

  async listSessions(principal: string, at: Date): Promise<CliSession[]> {
    try {
      const { rows } = await this.pool().query(
        `select session_id, client_name, approved_at, consumed_at, revoked_at
           from public.cli_device_codes
          where principal = $1 and session_id is not null
            and consumed_at > $2::timestamptz - make_interval(secs => $3)
          order by consumed_at desc`,
        [principal, at, SESSION_TTL_SECONDS],
      );
      return rows.map((r: Row) => ({
        id: String(r.session_id),
        clientName: (r.client_name as string | null) ?? null,
        approvedAt: iso(r.approved_at),
        createdAt: iso(r.consumed_at),
        expiresAt: new Date(date(r.consumed_at)!.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
        revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
      }));
    } catch (e) {
      rethrow(e);
    }
  }

  async revoke(principal: string, sessionId: string, at: Date): Promise<boolean> {
    try {
      const { rows } = await this.pool().query(
        `update public.cli_device_codes set revoked_at = coalesce(revoked_at, $3)
          where principal = $1 and session_id = $2
          returning session_id`,
        [principal, sessionId, at],
      );
      return rows.length > 0;
    } catch (e) {
      rethrow(e);
    }
  }

  async session(sessionId: string): Promise<CliSessionRecord | null> {
    try {
      const { rows } = await this.pool().query(`select principal, revoked_at from public.cli_device_codes where session_id = $1`, [sessionId]);
      if (!rows[0]) return null;
      return { principal: String(rows[0].principal), revoked: rows[0].revoked_at !== null };
    } catch (e) {
      rethrow(e);
    }
  }
}
