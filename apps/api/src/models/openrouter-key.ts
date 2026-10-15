/**
 * The BYOK OpenRouter key probe (plan 20261015-testmyagent-web2-client, ADR-5, task T8).
 *
 * `GET https://openrouter.ai/api/v1/key` with `Authorization: Bearer <key>`, 3 s timeout:
 *   - non-200 (401, 403, …)                    → `model_key_invalid`
 *   - 200 with `data.limit_remaining === 0`     → `model_key_no_credit`
 *   - 200 with an unknown body shape            → valid, with a warning log
 *   - a network error or the timeout            → `model_key_probe_unavailable` (the caller answers
 *                                                 503 with Retry-After and creates nothing)
 *
 * The key never goes to a log, an error message or a response: not in full, not a substring.
 * No log line in this module contains a value derived from the key.
 */
import type { ModelKeyProbe } from "../payments/adapters/free-byok.js";

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const PROBE_TIMEOUT_MS = 3_000;
/** Retry-After (seconds) of a `503 model_key_probe_unavailable`. */
export const PROBE_RETRY_AFTER_S = 30;

/** What the probe learned about a valid key. All fields are null when OpenRouter did not send them. */
export interface KeyInfo {
  label: string | null;
  /** US$ credit left on the key. Null = no limit (or not reported). */
  limitRemaining: number | null;
  isFreeTier: boolean | null;
}

export type KeyProbeResult =
  | { status: "valid"; info: KeyInfo }
  | { status: "invalid"; httpStatus: number }
  | { status: "no_credit"; info: KeyInfo }
  | { status: "unavailable"; reason: "timeout" | "network" };

export interface ProbeKeyOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Warning sink. Receives only fixed text and non-secret metadata. */
  warn?: (message: string) => void;
}

function readInfo(body: unknown): KeyInfo | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const lr = d.limit_remaining;
  // A recognised shape: at least one of the documented fields with its documented type.
  const known =
    typeof d.label === "string" || typeof lr === "number" || lr === null || typeof d.is_free_tier === "boolean" || typeof d.usage === "number";
  if (!known) return null;
  return {
    label: typeof d.label === "string" ? d.label : null,
    limitRemaining: typeof lr === "number" && Number.isFinite(lr) ? lr : null,
    isFreeTier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : null,
  };
}

/** Probes one OpenRouter key. Never throws, never logs the key. */
export async function probeKey(key: string, opts: ProbeKeyOptions = {}): Promise<KeyProbeResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  let res: Response;
  try {
    res = await fetchFn(OPENROUTER_KEY_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    return { status: "unavailable", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return { status: "invalid", httpStatus: res.status };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const info = readInfo(body);
  if (!info) {
    // Accept the key: OpenRouter said 200. The log names the problem only, never the key.
    warn("openrouter key probe: 200 with an unknown body shape; the key is accepted");
    return { status: "valid", info: { label: null, limitRemaining: null, isFreeTier: null } };
  }
  if (info.limitRemaining === 0) return { status: "no_credit", info };
  return { status: "valid", info };
}

/** The `ModelKeyProbe` of the free path (fills the T7 seam). */
export function createOpenRouterKeyProbe(opts: ProbeKeyOptions = {}): ModelKeyProbe {
  return async (key) => {
    const r = await probeKey(key, opts);
    switch (r.status) {
      case "valid":
        return { ok: true };
      case "invalid":
        return { ok: false, code: "model_key_invalid", message: "OpenRouter refused this API key" };
      case "no_credit":
        return { ok: false, code: "model_key_no_credit", message: "this OpenRouter API key has no credit left" };
      case "unavailable":
        return { ok: false, code: "model_key_probe_unavailable", message: "cannot reach OpenRouter to check the API key; try again", retryAfterSeconds: PROBE_RETRY_AFTER_S };
    }
  };
}
