import type { Pool } from "pg";
import { SchemaNotReadyError } from "./runs-store.js";
import { dflPrincipalId, USERS_MIGRATION, type DflLoginInput, type UserRecord, type UsersStore } from "./users-store.js";

const MISSING_SCHEMA_CODES = new Set(["42P01", "42703"]);

function rethrow(e: unknown): never {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
  if (code && MISSING_SCHEMA_CODES.has(code)) throw new SchemaNotReadyError(USERS_MIGRATION, e);
  throw e;
}

type Row = {
  principal_id: string;
  dfl_user_id: string;
  email: string | null;
  iam_level: number | null;
  disabled: boolean;
  created_at: Date;
  last_login_at: Date | null;
};

const toRecord = (r: Row): UserRecord => ({
  principalId: r.principal_id,
  dflUserId: r.dfl_user_id,
  email: r.email,
  iamLevel: r.iam_level,
  disabled: r.disabled,
  createdAt: r.created_at.toISOString(),
  lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
});

export class PgUsersStore implements UsersStore {
  constructor(private readonly pool: () => Pool) {}

  async upsertDflLogin(input: DflLoginInput): Promise<UserRecord> {
    const dflUserId = input.dflUserId.toLowerCase();
    const r = await this.pool()
      .query<Row>(
        `insert into public.users (principal_id, dfl_user_id, email, iam_level, last_login_at)
         values ($1, $2, $3, $4, $5)
         on conflict (principal_id) do update
           set email = excluded.email,
               iam_level = coalesce(excluded.iam_level, public.users.iam_level),
               last_login_at = excluded.last_login_at
         returning *`,
        [dflPrincipalId(dflUserId), dflUserId, input.email, input.iamLevel, input.now ?? new Date()],
      )
      .catch(rethrow);
    return toRecord(r.rows[0]!);
  }

  async get(principalId: string): Promise<UserRecord | null> {
    const r = await this.pool().query<Row>(`select * from public.users where principal_id = $1`, [principalId]).catch(rethrow);
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }
}
