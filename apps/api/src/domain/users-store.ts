/**
 * Account state of the web2 principals (Login with DFL), task T5 of plan
 * 20261015-testmyagent-web2-client (ADR-3, ADR-9). Table `users`
 * (db/migrations/0018_users_principal.sql). SIWS principals have no row: their wallet is the whole
 * account.
 */

export const USERS_MIGRATION = "0018_users_principal.sql";

export interface UserRecord {
  /** `dfl:<uuid>`. */
  principalId: string;
  dflUserId: string;
  email: string | null;
  /** The DFL IAM level read at the last login, or null when the API did not read it. */
  iamLevel: number | null;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface DflLoginInput {
  dflUserId: string;
  email: string | null;
  /** Null keeps the stored level. */
  iamLevel: number | null;
  now?: Date;
}

export interface UsersStore {
  /** Inserts the row on the first login, else updates email, iam_level (when given) and last_login_at.
   * Returns the row after the write. Never changes `disabled`. */
  upsertDflLogin(input: DflLoginInput): Promise<UserRecord>;
  get(principalId: string): Promise<UserRecord | null>;
}

export function dflPrincipalId(dflUserId: string): string {
  return `dfl:${dflUserId.toLowerCase()}`;
}
