/**
 * The platform-key allowance of the free path (plan 20261015-testmyagent-web2-client, ADR-5, Q2).
 * It is OFF by default. When it is off, a free evaluation without a key answers
 * `422 model_key_required`, and the platform key is never read.
 *
 * - `TMA_PLATFORM_KEY_ENABLED` (default false): `true` turns the allowance on.
 * - `TMA_PLATFORM_RUNS_PER_USER_PER_DAY` (default 3): platform-paid runs per principal per 24 h.
 * - `TMA_PLATFORM_MAX_PROMPT_USD_PER_TOKEN` (default 0.0000005, US$0.50 per 1M prompt tokens): the
 *   most expensive model (OpenRouter list price, per prompt token) that the platform key pays.
 * - `TMA_RUNNER_OPENROUTER_KEY`: the platform OpenRouter key. Read ONLY when the flag is on. No
 *   value lives in the repo.
 */
export interface PlatformKeyConfig {
  enabled: boolean;
  runsPerUserPerDay: number;
  maxPromptUsdPerToken: number;
  /** Null when the flag is off, or when the flag is on and the key is not set. */
  key: string | null;
}

export const DEFAULT_PLATFORM_RUNS_PER_USER_PER_DAY = 3;
export const DEFAULT_PLATFORM_MAX_PROMPT_USD_PER_TOKEN = 0.0000005;

export const PLATFORM_KEY_OFF: PlatformKeyConfig = {
  enabled: false,
  runsPerUserPerDay: DEFAULT_PLATFORM_RUNS_PER_USER_PER_DAY,
  maxPromptUsdPerToken: DEFAULT_PLATFORM_MAX_PROMPT_USD_PER_TOKEN,
  key: null,
};

function positiveNumber(name: string, raw: string | undefined, fallback: number, integer: boolean): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be a${integer ? "n integer" : " number"} >= 0, got "${raw}"`);
  }
  return n;
}

export function platformKeyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PlatformKeyConfig {
  const enabled = env.TMA_PLATFORM_KEY_ENABLED?.trim().toLowerCase() === "true";
  return {
    enabled,
    runsPerUserPerDay: positiveNumber("TMA_PLATFORM_RUNS_PER_USER_PER_DAY", env.TMA_PLATFORM_RUNS_PER_USER_PER_DAY, DEFAULT_PLATFORM_RUNS_PER_USER_PER_DAY, true),
    maxPromptUsdPerToken: positiveNumber(
      "TMA_PLATFORM_MAX_PROMPT_USD_PER_TOKEN",
      env.TMA_PLATFORM_MAX_PROMPT_USD_PER_TOKEN,
      DEFAULT_PLATFORM_MAX_PROMPT_USD_PER_TOKEN,
      false,
    ),
    key: enabled ? env.TMA_RUNNER_OPENROUTER_KEY?.trim() || null : null,
  };
}
