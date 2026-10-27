import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CORS allow-list. Only the known web app origins by default — never `*`, since this API will
 * grow endpoints that are not pure read-only (per feedback_seguranca_cors_rate_limit: CORS wide
 * open is only acceptable for a fully public, read-only, side-effect-free endpoint). Override via
 * env var for a preview deployment or a local dev origin that isn't the Vite default.
 * `https://testmyagent.com` is the web2 domain (Tainan TG 24166, 2026-10-27). The old host
 * `testmyagent.devfellowship.com` was deleted (Tainan TG 24234), so it is not an origin any more.
 */
export const CORS_ALLOWED_ORIGINS = (
  process.env.ITERA_API_CORS_ORIGINS ??
  "https://itera-agent-credentials.devfellowship.com,https://testmyagent.com,http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Number of reverse proxies in front of this API whose `X-Forwarded-For` entry we trust. Production
 * runs behind exactly one: the Traefik reverse proxy of the deploy platform.
 * Traefik does not trust a client-supplied X-Forwarded-For, so it sets the header to the real
 * client address and `1` makes `req.ip` that address. Never raise this to "trust everything": a
 * hop count that is too high lets a client choose its own rate-limit bucket by sending a header.
 * Set it to 0 when the API is reached directly (local dev, a test).
 */
function parseHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) {
    throw new Error(`ITERA_API_TRUST_PROXY must be an integer from 0 to 5, got "${raw}"`);
  }
  return n;
}
export const TRUST_PROXY_HOPS = parseHops(process.env.ITERA_API_TRUST_PROXY);

/**
 * Rate limits — this API is reachable from the public internet, so every route needs a default
 * limit (per feedback_seguranca_cors_rate_limit). A bucket is one client IP (the real one, see
 * TRUST_PROXY_HOPS) or, for a request with a valid session token, one wallet. Window/max are
 * env-overridable for load testing without a code change; production sets no override.
 *
 * `PUBLIC_MAX_REQUESTS` is the separate, higher limit for the public cached GETs (/public/*,
 * /nft/*, /badge/*, /b/*): shared profile pages, README badges and link previews that many
 * unrelated visitors load.
 */
export const RATE_LIMIT = {
  WINDOW_MS: Number(process.env.ITERA_API_RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000),
  MAX_REQUESTS: Number(process.env.ITERA_API_RATE_LIMIT_MAX ?? 600),
  PUBLIC_MAX_REQUESTS: Number(process.env.ITERA_API_PUBLIC_RATE_LIMIT_MAX ?? 3000),
} as const;

/**
 * Login with DFL (web2 client, plan 20261015-testmyagent-web2-client ADR-2). Read per request so
 * the API boots without them: the web3 flow never needs them.
 * - `DFL_SUPABASE_URL`: the DFL Supabase project that issues the DFL token.
 * - `DFL_SUPABASE_ANON_KEY`: the public anon key of that project (never the service role). When it
 *   is absent, `POST /auth/dfl/exchange` answers `503 dfl_auth_not_configured`.
 * - `TMA_MIN_IAM_LEVEL` (default 0): the lowest DFL IAM level that may log in. 0 = any DFL user.
 */
export const DEFAULT_DFL_SUPABASE_URL = "https://yoojxnggaxcqtsyjdrdx.supabase.co";

export interface DflAuthConfig {
  supabaseUrl: string;
  anonKey: string | null;
  minIamLevel: number;
}

export function dflAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DflAuthConfig {
  const rawLevel = env.TMA_MIN_IAM_LEVEL?.trim();
  const minIamLevel = rawLevel ? Number(rawLevel) : 0;
  if (!Number.isInteger(minIamLevel) || minIamLevel < 0) {
    throw new Error(`TMA_MIN_IAM_LEVEL must be an integer >= 0, got "${rawLevel}"`);
  }
  return {
    supabaseUrl: (env.DFL_SUPABASE_URL?.trim() || DEFAULT_DFL_SUPABASE_URL).replace(/\/+$/, ""),
    anonKey: env.DFL_SUPABASE_ANON_KEY?.trim() || null,
    minIamLevel,
  };
}

/**
 * House pattern for any future secret this API reads (Solana keys, IPFS pinning tokens, etc. —
 * see services/attestation/src/config.ts for the same shape): read from an env var that the deploy
 * platform injects from the secret store, no default, throw loud instead of silently running with a missing credential.
 * No route uses this yet — apps/api is still a skeleton — but new secret-consuming code should
 * follow this shape rather than reading process.env inline at the call site.
 */
export function requiredSecret(envVarName: string): string {
  const value = process.env[envVarName];
  if (!value) {
    throw new Error(
      `${envVarName} is not set. Set it in the secret store of this deployment and ` +
        "confirm it's wired into the app's environment variables.",
    );
  }
  return value;
}

/**
 * Postgres connection string for the testmyagent entity model (vendors, agents, runs, claim
 * manifests, ... — see db/migrations/). Read
 * lazily (only when a route actually needs the DB) so `npm run dev`/tests don't require it to be
 * set just to boot the process.
 */
export function databaseUrl(): string {
  return requiredSecret("DATABASE_URL");
}

/**
 * Same hot signer this project has used since the pre-pivot attestation work
 * (services/attestation/src/config.ts) — already authorized on the live Credential and funded on
 * devnet. No default path, same reasoning as everywhere else this pattern appears: forgetting to
 * set it must fail loud, never silently reuse some other key.
 *
 * Two ways to provide it, by environment:
 * - `ITERA_HOT_SIGNER_KEYPAIR_PATH`: a file already on disk — the local-dev workflow this project
 *   has used since the pre-pivot work, no change needed there.
 * - `ITERA_HOT_SIGNER_KEYPAIR_B64`: the keypair JSON, base64-encoded, as an env var — production's
 *   shape, since the Docker image has no such file baked in and shouldn't. Materialized to a temp
 *   file on first use (`@solana/kit-plugin-signer`'s `payerFromFile` needs a path, not raw bytes)
 *   and memoized so it's written at most once per process.
 */
/**
 * Shared shape for "a key that's either a local file (dev) or base64 content in an env var
 * (prod, where the Docker image has no such file baked in and shouldn't)". Materializes the file
 * at most once per process, with 0o600 permissions since it's key material.
 */
function materializedKeyPath(pathEnvVar: string, contentEnvVar: string, filename: string, hint: string): () => string {
  let materialized: string | null = null;
  return () => {
    const directPath = process.env[pathEnvVar];
    if (directPath) return directPath;
    if (materialized) return materialized;
    const b64 = requiredSecretWithHint(contentEnvVar, hint);
    const path = join(tmpdir(), filename);
    writeFileSync(path, Buffer.from(b64, "base64"), { mode: 0o600 });
    materialized = path;
    return path;
  };
}

function requiredSecretWithHint(envVarName: string, hint: string): string {
  const value = process.env[envVarName];
  if (!value) throw new Error(`${envVarName} is not set. ${hint}`);
  return value;
}

/**
 * Same hot signer this project has used since the pre-pivot attestation work
 * (services/attestation/src/config.ts) — already authorized on the live Credential and funded on
 * devnet. No default path, same reasoning as everywhere else this pattern appears: forgetting to
 * set it must fail loud, never silently reuse some other key.
 *
 * Two ways to provide it, by environment:
 * - `ITERA_HOT_SIGNER_KEYPAIR_PATH`: a file already on disk — the local-dev workflow this project
 *   has used since the pre-pivot work, no change needed there.
 * - `ITERA_HOT_SIGNER_KEYPAIR_B64`: the keypair JSON, base64-encoded, as an env var — production's
 *   shape. Materialized to a temp file on first use (`@solana/kit-plugin-signer`'s `payerFromFile`
 *   needs a path, not raw bytes) and memoized so it's written at most once per process.
 */
export const hotSignerKeypairPath = materializedKeyPath(
  "ITERA_HOT_SIGNER_KEYPAIR_PATH",
  "ITERA_HOT_SIGNER_KEYPAIR_B64",
  "itera-hot-signer.json",
  "Set either ITERA_HOT_SIGNER_KEYPAIR_PATH (a local file) or ITERA_HOT_SIGNER_KEYPAIR_B64 " +
    "(the keypair JSON, base64-encoded) in the secret store of this deployment.",
);

/**
 * SSH deploy key (write access) for D0ingC0des/itera-agent-manifests — the public repo
 * domain/manifests-repo.ts commits submitted .md files to. Same materialization pattern as the
 * hot signer: a local file path for dev, or base64 SSH private key content in production.
 */
export const manifestsDeployKeyPath = materializedKeyPath(
  "ITERA_MANIFESTS_DEPLOY_KEY_PATH",
  "ITERA_MANIFESTS_DEPLOY_KEY_B64",
  "itera-manifests-deploy-key",
  "Set either ITERA_MANIFESTS_DEPLOY_KEY_PATH (a local file) or ITERA_MANIFESTS_DEPLOY_KEY_B64 " +
    "(the SSH private key, base64-encoded, no passphrase) in the secret store of this deployment.",
);
