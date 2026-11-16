// Test helpers of `tma studio serve`. All synthetic: no real trace, task, repo or host text.
// A fake TMA API signs and checks HS256 tokens with a test-only key, as apps/api/src/auth/session.ts does.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Introspect } from './auth.js';
import { FIXTURE_VARIANT } from './fixture.js';

const TEST_KEY = 'studio-fixture-key-not-a-secret';
export const ALLOWED = 'dfl:00000000-0000-4000-8000-000000000001';
export const OTHER = 'dfl:00000000-0000-4000-8000-000000000002';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function signToken(claims: Record<string, unknown>, key = TEST_KEY): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(claims);
  const sig = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function webToken(sub = ALLOWED, nowMs = Date.now(), ttlS = 3600): string {
  const iat = Math.floor(nowMs / 1000);
  return signToken({ sub, amr: 'dfl', iat, exp: iat + ttlS, iss: 'itera-api' });
}

/** A fake `GET /auth/me`: 200 {id} for a token with a valid test signature that has not expired, else 401. */
export function fakeApi(opts: { disabled?: Set<string> } = {}): Introspect & { calls: number } {
  const fn = Object.assign(async (token: string): Promise<{ status: number; body: Record<string, unknown> | null }> => {
    fn.calls++;
    const [h, p, s] = token.split('.');
    const expected = createHmac('sha256', TEST_KEY).update(`${h}.${p}`).digest();
    const given = Buffer.from(s ?? '', 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { status: 401, body: { error: 'unauthorized' } };
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as { sub: string; exp: number };
    if (claims.exp * 1000 <= Date.now()) return { status: 401, body: { error: 'unauthorized' } };
    if (opts.disabled?.has(claims.sub)) return { status: 403, body: { error: 'account_disabled' } };
    return { status: 200, body: { id: claims.sub, kind: 'dfl', wallet: claims.sub } };
  }, { calls: 0 });
  return fn;
}

// The synthetic tree itself lives in fixture.ts (also used by `tma studio fixture`).
export { buildFixture, FIXTURE_VARIANT } from './fixture.js';
export const SID_A = FIXTURE_VARIANT.sidA;
export const SID_B = FIXTURE_VARIANT.sidB;
export const SID_OUTSIDE = FIXTURE_VARIANT.sidOutside;
export const SUB_AGENT = FIXTURE_VARIANT.subAgent;
