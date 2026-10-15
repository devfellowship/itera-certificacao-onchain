import { dflPrincipalId, type DflLoginInput, type UserRecord, type UsersStore } from "./users-store.js";

/** In-memory `UsersStore` for tests. */
export class FakeUsersStore implements UsersStore {
  readonly rows = new Map<string, UserRecord>();
  upserts = 0;

  async upsertDflLogin(input: DflLoginInput): Promise<UserRecord> {
    this.upserts += 1;
    const now = (input.now ?? new Date()).toISOString();
    const principalId = dflPrincipalId(input.dflUserId);
    const existing = this.rows.get(principalId);
    const row: UserRecord = existing
      ? { ...existing, email: input.email, iamLevel: input.iamLevel ?? existing.iamLevel, lastLoginAt: now }
      : {
          principalId,
          dflUserId: input.dflUserId.toLowerCase(),
          email: input.email,
          iamLevel: input.iamLevel,
          disabled: false,
          createdAt: now,
          lastLoginAt: now,
        };
    this.rows.set(principalId, row);
    return { ...row };
  }

  async get(principalId: string): Promise<UserRecord | null> {
    const row = this.rows.get(principalId);
    return row ? { ...row } : null;
  }
}
