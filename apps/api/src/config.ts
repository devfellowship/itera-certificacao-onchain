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
