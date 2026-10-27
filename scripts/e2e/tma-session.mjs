#!/usr/bin/env node
// tma-session.mjs: a TestMyAgent web session for a chosen DFL identity, for e2e checks
// (plan 20261026-tma-local-runner-and-self-declared-results, L13, drift "no helper mints a TMA
// session for a chosen identity").
//
// It does what web2 does on "Login with DFL": a DFL Supabase password sign-in, then
// POST {API}/auth/dfl/exchange. It never prints a token. The credentials come from the environment
// only (a smoke identity, fetched by the caller and unset after use):
//
//   TMA_E2E_DFL_EMAIL, TMA_E2E_DFL_PASSWORD   the DFL login of the identity
//   DFL_SUPABASE_URL, DFL_SUPABASE_ANON_KEY   the DFL Supabase project (the anon key is public)
//   TMA_API_URL                               default https://itera-agent-credentials-api.devfellowship.com
//
// Commands:
//   whoami                      the principal id and email of the session
//   approve <user code>         approve a `tma login` device code, as the web page /cli?code= does
//   get <api path>              GET an API path with the session; prints the JSON body
//   storage-state <file> <origin>
//                               write a Playwright storageState (mode 600) with the web2 session
//                               (localStorage `tma2.session`), for verify-render --storage-state.
//                               The file holds a 24 h session: delete it right after use.
import { writeFileSync, chmodSync } from 'node:fs';

const env = (name, fallback) => {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  console.error(`tma-session: set ${name}`);
  process.exit(2);
};

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

async function session() {
  const supabase = env('DFL_SUPABASE_URL').replace(/\/+$/, '');
  const anon = env('DFL_SUPABASE_ANON_KEY');
  const signIn = await fetch(`${supabase}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'content-type': 'application/json' },
    body: JSON.stringify({ email: env('TMA_E2E_DFL_EMAIL'), password: env('TMA_E2E_DFL_PASSWORD') }),
  });
  const s = await json(signIn);
  if (!signIn.ok || typeof s.access_token !== 'string') throw new Error(`DFL sign-in failed: HTTP ${signIn.status} ${s.error_description ?? s.msg ?? ''}`);
  const api = env('TMA_API_URL', 'https://itera-agent-credentials-api.devfellowship.com').replace(/\/+$/, '');
  const ex = await fetch(`${api}/auth/dfl/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dflToken: s.access_token }),
  });
  const e = await json(ex);
  if (!ex.ok || typeof e.sessionToken !== 'string') throw new Error(`TMA exchange failed: HTTP ${ex.status} ${e.error ?? ''}`);
  return { api, token: e.sessionToken, user: e.user };
}

const call = (s, path, init = {}) =>
  fetch(`${s.api}${path}`, { ...init, headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

async function main([cmd, ...args]) {
  if (!['whoami', 'approve', 'get', 'storage-state'].includes(cmd)) {
    console.error('usage: tma-session.mjs whoami | approve <user code> | get <api path> | storage-state <file> <origin>');
    return 1;
  }
  const s = await session();
  if (cmd === 'whoami') {
    console.log(JSON.stringify({ id: s.user?.id, email: s.user?.email }));
    return 0;
  }
  if (cmd === 'approve') {
    const code = args[0];
    if (!code) throw new Error('approve needs the user code that `tma login` printed');
    const read = await call(s, `/auth/cli/requests/${encodeURIComponent(code)}`);
    const r = await json(read);
    console.log(`request ${code}: HTTP ${read.status} state=${r.state ?? r.error} client=${r.client_name ?? '-'}`);
    if (!read.ok) return 1;
    const ap = await call(s, '/auth/cli/approve', { method: 'POST', body: JSON.stringify({ user_code: code }) });
    const a = await json(ap);
    console.log(`approve ${code}: HTTP ${ap.status} state=${a.state ?? a.error}`);
    return ap.ok ? 0 : 1;
  }
  if (cmd === 'get') {
    const res = await call(s, args[0] ?? '/auth/me');
    console.log(JSON.stringify({ status: res.status, body: await json(res) }, null, 2));
    return res.ok ? 0 : 1;
  }
  const [file, origin] = args;
  if (!file || !origin) throw new Error('storage-state needs <file> <origin>');
  const value = JSON.stringify({ token: s.token, user: { id: s.user.id, email: s.user.email ?? '' } });
  writeFileSync(file, JSON.stringify({ cookies: [], origins: [{ origin, localStorage: [{ name: 'tma2.session', value }] }] }), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`storage state for ${s.user.id} written (mode 600); delete it after use`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`tma-session: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
