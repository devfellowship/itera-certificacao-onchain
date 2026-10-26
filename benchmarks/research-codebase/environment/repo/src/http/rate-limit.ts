export interface Limiter {
  allow(clientId: string, now: number): boolean;
}

export function rejectTooManyRequests(retryAfterSeconds: number): { status: number; headers: Record<string, string>; body: string } {
  return {
    status: 429,
    headers: { 'retry-after': String(retryAfterSeconds) },
    body: 'rate limit exceeded',
  };
}

export function createRateLimiter(maxPerWindow: number, windowMs: number): Limiter {
  const hits = new Map<string, number[]>();
  return {
    allow(clientId, now) {
      const recent = (hits.get(clientId) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= maxPerWindow) return false;
      recent.push(now);
      hits.set(clientId, recent);
      return true;
    },
  };
}
