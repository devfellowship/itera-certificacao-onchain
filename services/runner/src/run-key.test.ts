import { describe, expect, it } from 'vitest';
import * as api from '../../../apps/api/src/domain/run-key.js';
import { decryptRunKey, encryptRunKey } from './run-key.js';

const SECRET = 'x'.repeat(48);

describe('run key (BYOK) encryption', () => {
  it('round-trips, and a sealed value never contains the key', () => {
    const sealed = encryptRunKey('sk-or-v1-abc', SECRET);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('sk-or');
    expect(decryptRunKey(sealed, SECRET)).toBe('sk-or-v1-abc');
  });

  it('is compatible with the API copy in both directions', () => {
    expect(decryptRunKey(api.encryptRunKey('sk-or-v1-from-api', SECRET), SECRET)).toBe('sk-or-v1-from-api');
    expect(api.decryptRunKey(encryptRunKey('sk-or-v1-from-runner', SECRET), SECRET)).toBe('sk-or-v1-from-runner');
  });

  it('refuses a wrong secret, a tampered value and a short secret', () => {
    const sealed = encryptRunKey('sk-or-v1-abc', SECRET);
    expect(() => decryptRunKey(sealed, 'y'.repeat(48))).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptRunKey(parts.join('.'), SECRET)).toThrow();
    expect(() => encryptRunKey('k', 'short')).toThrow(/32 characters/);
  });
});
