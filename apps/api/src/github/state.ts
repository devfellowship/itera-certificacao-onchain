import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed `state` for the GitHub App install URL: binds the install to the wallet that started it.
 * Format: base64url(JSON{w, n, exp}) + "." + base64url(HMAC-SHA256). Keyed with
 * ITERA_SESSION_SECRET (the same secret lane A uses for session tokens), with a distinct prefix so a
 * state can never be replayed as a session token or vice versa.
 */
const PREFIX = "itera-gh-install-state:";
const TTL_SECONDS = 30 * 60;

function mac(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(PREFIX + body).digest();
}

export function signInstallState(wallet: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const body = Buffer.from(JSON.stringify({ w: wallet, n: randomBytes(12).toString("base64url"), exp: nowSeconds + TTL_SECONDS })).toString("base64url");
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

/** Returns the wallet, or null when the state is malformed, forged or expired. */
export function verifyInstallState(state: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  const [body, sig, ...rest] = state.split(".");
  if (!body || !sig || rest.length > 0) return null;
  const expected = mac(secret, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as { w?: unknown; exp?: unknown };
    if (typeof parsed.w !== "string" || typeof parsed.exp !== "number" || parsed.exp < nowSeconds) return null;
    return parsed.w;
  } catch {
    return null;
  }
}
