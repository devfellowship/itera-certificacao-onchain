import { createHash, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(salt + ':' + password).digest('hex');
}

export function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
