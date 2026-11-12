// The login check of `tma studio serve` (task C5-T11): valid token, expired, wrong signature, missing,
// plus the allow-list, a CLI session, a disabled account and an API outage. Fixtures only.
import { describe, expect, it } from 'vitest';
import { bearerToken, checkLogin, precheckToken } from './auth.js';
import { ALLOWED, fakeApi, OTHER, signToken, webToken } from './fixture.test-helpers.js';

const deps = (api = fakeApi(), allow = [ALLOWED]) => ({ introspect: api, allowPrincipals: new Set(allow) });

describe('studio serve login check', () => {
  it('accepts a valid web session of an allowed principal (the API confirms it)', async () => {
    const api = fakeApi();
    const r = await checkLogin(`Bearer ${webToken()}`, deps(api));
    expect(r).toEqual({ ok: true, principal: ALLOWED });
    expect(api.calls).toBe(1);
  });

  it('checks again on every call (no cache)', async () => {
    const api = fakeApi();
    const token = webToken();
    await checkLogin(`Bearer ${token}`, deps(api));
    await checkLogin(`Bearer ${token}`, deps(api));
    expect(api.calls).toBe(2);
  });

  it('refuses an expired token with 401, without a network call', async () => {
    const api = fakeApi();
    const r = await checkLogin(`Bearer ${webToken(ALLOWED, Date.now() - 2 * 3600_000, 3600)}`, deps(api));
    expect(r).toEqual({ ok: false, status: 401, reason: 'expired_token' });
    expect(api.calls).toBe(0);
  });

  it('refuses a token with a wrong signature with 401 (the API refuses it)', async () => {
    const forged = signToken({ sub: ALLOWED, amr: 'dfl', exp: Math.floor(Date.now() / 1000) + 3600 }, 'another-key');
    const r = await checkLogin(`Bearer ${forged}`, deps());
    expect(r).toEqual({ ok: false, status: 401, reason: 'invalid_session' });
  });

  it('refuses a token whose payload was changed after signing', async () => {
    const [h, , s] = webToken(OTHER).split('.');
    const swapped = Buffer.from(JSON.stringify({ sub: ALLOWED, amr: 'dfl', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const r = await checkLogin(`Bearer ${h}.${swapped}.${s}`, deps());
    expect(r).toEqual({ ok: false, status: 401, reason: 'invalid_session' });
  });

  it('refuses a missing token with 401', async () => {
    for (const header of [undefined, '', 'Basic abc', 'Bearer', ['Bearer a', 'Bearer b']]) {
      expect(await checkLogin(header, deps())).toEqual({ ok: false, status: 401, reason: 'missing_token' });
    }
  });

  it('refuses a malformed token with 401', async () => {
    for (const t of ['abc', 'a.b', 'a.b.c', `${Buffer.from('{"alg":"none"}').toString('base64url')}.e30.x`]) {
      const r = await checkLogin(`Bearer ${t}`, deps());
      expect(r).toEqual({ ok: false, status: 401, reason: 'malformed_token' });
    }
  });

  it('refuses a valid session of a principal that is not allowed with 403, without a network call', async () => {
    const api = fakeApi();
    expect(await checkLogin(`Bearer ${webToken(OTHER)}`, deps(api))).toEqual({ ok: false, status: 403, reason: 'principal_not_allowed' });
    expect(api.calls).toBe(0);
  });

  it('refuses everyone when the allow-list is empty', async () => {
    expect(await checkLogin(`Bearer ${webToken()}`, deps(fakeApi(), []))).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a CLI session (it carries sid) with 401', async () => {
    const cli = signToken({ sub: ALLOWED, amr: 'dfl', sid: 'session-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(await checkLogin(`Bearer ${cli}`, deps())).toEqual({ ok: false, status: 401, reason: 'cli_session_refused' });
  });

  it('refuses a disabled account with 403 (the API answers 403)', async () => {
    const r = await checkLogin(`Bearer ${webToken()}`, deps(fakeApi({ disabled: new Set([ALLOWED]) })));
    expect(r).toEqual({ ok: false, status: 403, reason: 'account_refused' });
  });

  it('refuses when the API id differs from the token sub', async () => {
    const lying = Object.assign(async () => ({ status: 200, body: { id: OTHER } }), { calls: 0 });
    expect(await checkLogin(`Bearer ${webToken()}`, deps(lying, [ALLOWED, OTHER]))).toEqual({ ok: false, status: 401, reason: 'invalid_session' });
  });

  it('answers 503 when the API cannot be reached or answers an error', async () => {
    const down = Object.assign(async () => {
      throw new Error('ECONNREFUSED');
    }, { calls: 0 });
    expect(await checkLogin(`Bearer ${webToken()}`, deps(down))).toEqual({ ok: false, status: 503, reason: 'auth_unavailable' });
    const err = Object.assign(async () => ({ status: 502, body: null }), { calls: 0 });
    expect(await checkLogin(`Bearer ${webToken()}`, deps(err))).toEqual({ ok: false, status: 503, reason: 'auth_unavailable' });
  });

  it('bearerToken and precheckToken read only the shape', () => {
    expect(bearerToken('bearer  x.y.z ')).toBe('x.y.z');
    expect(precheckToken(webToken(), Date.now())).toMatchObject({ ok: true, claims: { sub: ALLOWED } });
  });
});
