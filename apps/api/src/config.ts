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
