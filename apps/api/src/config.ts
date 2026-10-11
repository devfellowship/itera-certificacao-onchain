import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CORS allow-list. Only the known web app origins by default — never `*`, since this API will
 * grow endpoints that are not pure read-only (per feedback_seguranca_cors_rate_limit: CORS wide
 * open is only acceptable for a fully public, read-only, side-effect-free endpoint). Override via
 * env var for a preview deployment or a local dev origin that isn't the Vite default.
 */
export const CORS_ALLOWED_ORIGINS = (
  process.env.ITERA_API_CORS_ORIGINS ??
  "https://itera-agent-credentials.devfellowship.com,http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Global rate limit — this API is reachable from the public internet with no auth in front of it
 * yet, so every route needs a default limit even before any specific endpoint is auth/webhook
 * shaped (per feedback_seguranca_cors_rate_limit). Window/max are env-overridable for load testing
 * without a code change.
 */
export const RATE_LIMIT = {
  WINDOW_MS: Number(process.env.ITERA_API_RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000),
  MAX_REQUESTS: Number(process.env.ITERA_API_RATE_LIMIT_MAX ?? 300),
} as const;

/**
 * House pattern for any future secret this API reads (Solana keys, IPFS pinning tokens, etc. —
 * see services/attestation/src/config.ts for the same shape): read from an env var Dokploy injects
 * from Infisical, no default, throw loud instead of silently running with a missing credential.
 * No route uses this yet — apps/api is still a skeleton — but new secret-consuming code should
 * follow this shape rather than reading process.env inline at the call site.
 */
export function requiredSecret(envVarName: string): string {
  const value = process.env[envVarName];
  if (!value) {
    throw new Error(
      `${envVarName} is not set. Set it in Infisical under /apps/itera-agent-credentials/ and ` +
        "confirm it's wired into the Dokploy app's environment variables.",
    );
  }
  return value;
}

/**
 * Postgres connection string for the testmyagent entity model (vendors, agents, runs, claim
 * manifests, ... — see the 2026-10-11 migration on the itera-hackatoon Supabase project). Read
 * lazily (only when a route actually needs the DB) so `npm run dev`/tests don't require it to be
 * set just to boot the process.
 */
export function databaseUrl(): string {
  return requiredSecret("DATABASE_URL");
}

/**
 * Shared-secret operator gate for the three write/operator endpoints (POST /evaluations,
 * GET /evaluations/:id/events, POST /evaluations/:id/publish). The doc says "No hackathon,
 * proteger writes com acesso de operador e deixar pública apenas evidência consentida" — there is
 * no login system anywhere in this monorepo yet, so a real user-auth model is out of scope here.
 * A shared header key is the honest minimum: it prevents an anonymous internet caller from
 * creating runs or publishing claims, without pretending to be a full auth system.
 */
export function operatorApiKey(): string {
  return requiredSecret("ITERA_API_OPERATOR_KEY");
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
let materializedHotSignerPath: string | null = null;

export function hotSignerKeypairPath(): string {
  const directPath = process.env.ITERA_HOT_SIGNER_KEYPAIR_PATH;
  if (directPath) return directPath;

  if (materializedHotSignerPath) return materializedHotSignerPath;
  const b64 = requiredSecretWithHint(
    "ITERA_HOT_SIGNER_KEYPAIR_B64",
    "Set either ITERA_HOT_SIGNER_KEYPAIR_PATH (a local file) or ITERA_HOT_SIGNER_KEYPAIR_B64 " +
      "(the keypair JSON, base64-encoded) in Infisical under /apps/itera-agent-credentials/.",
  );
  const path = join(tmpdir(), "itera-hot-signer.json");
  writeFileSync(path, Buffer.from(b64, "base64"), { mode: 0o600 });
  materializedHotSignerPath = path;
  return path;
}

function requiredSecretWithHint(envVarName: string, hint: string): string {
  const value = process.env[envVarName];
  if (!value) throw new Error(`${envVarName} is not set. ${hint}`);
  return value;
}
