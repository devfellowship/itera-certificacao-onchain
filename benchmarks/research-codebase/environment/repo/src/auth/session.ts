export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

export function createSession(userId: string, now: number): Session {
  return {
    id: userId + ':' + now.toString(36),
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    revokedAt: null,
  };
}

export function isSessionExpired(session: Session, now: number): boolean {
  if (session.revokedAt !== null) return true;
  return now >= session.expiresAt;
}

export function revokeSession(session: Session, now: number): Session {
  if (session.revokedAt !== null) return session;
  return { ...session, revokedAt: now };
}
