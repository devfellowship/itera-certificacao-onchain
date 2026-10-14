/**
 * Model usage of one run, as measured by the run's model gateway (sandbox/model-gateway.mjs) from
 * OpenRouter's `usage` objects. `costUsd` is what OpenRouter charged (credits, 1 credit = 1 USD).
 */
export interface ModelUsage {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Model calls that reached the upstream. */
  calls: number;
  /** Model calls that the gateway refused because the run reached its cost cap. */
  refused: number;
  maxCostUsd: number;
  /** True when the gateway refused at least one call: the cap stopped the agent. */
  capStopped: boolean;
  /**
   * K10: how costUsd was obtained. `metered` = the provider's own USD (OpenRouter); `derived` = tokens ×
   * the runner's price table (opencode go answers no cost); `unpriced` = no price known, cost 0;
   * `mixed` = more than one of these; `none` = no call carried usage.
   */
  costSource: CostSource;
  /** K11: upstream 429 answers, and those that survived the gateway's retries (reached the agent). */
  rateLimited: number;
  rateLimitedFinal: number;
  /** K11: model id → calls as ANSWERED by the upstream; provider → calls; requested model → calls. */
  effectiveModels: Record<string, number>;
  providers: Record<string, number>;
  requestedModels: Record<string, number>;
  /** K11: sampling params of the first model call (temperature, max tokens, reasoning, ...). */
  params: Record<string, unknown> | null;
}

function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>).slice(0, 20)) out[k.slice(0, 120)] = Math.round(num(n));
  return out;
}

/** The key with the most calls, or null. */
export function topKey(m: Record<string, number>): string | null {
  let best: string | null = null;
  for (const [k, n] of Object.entries(m)) if (best === null || n > m[best]!) best = k;
  return best;
}

export type CostSource = 'metered' | 'derived' | 'mixed' | 'unpriced' | 'none';
const COST_SOURCES: readonly CostSource[] = ['metered', 'derived', 'mixed', 'unpriced', 'none'];

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** The last `{"event":"usage",...}` line of the gateway's stdout, or null. */
export function parseGatewayUsage(logs: string): ModelUsage | null {
  let last: Record<string, unknown> | null = null;
  for (const line of logs.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.includes('"usage"')) continue;
    try {
      const doc = JSON.parse(t);
      if (doc && doc.event === 'usage') last = doc;
    } catch {
      // not a gateway JSON line
    }
  }
  if (!last) return null;
  const refused = num(last.refused);
  return {
    costUsd: Math.round(num(last.cost_usd) * 1e8) / 1e8,
    tokensIn: Math.round(num(last.tokens_in)),
    tokensOut: Math.round(num(last.tokens_out)),
    calls: Math.round(num(last.calls)),
    refused,
    maxCostUsd: num(last.max_cost_usd),
    capStopped: refused > 0,
    // A gateway from before K10 logs no cost_source: its cost was always OpenRouter's own.
    rateLimited: Math.round(num(last.rate_limited)),
    rateLimitedFinal: Math.round(num(last.rate_limited_final)),
    effectiveModels: counts(last.effective_models),
    providers: counts(last.providers),
    requestedModels: counts(last.requested_models),
    params: last.params && typeof last.params === 'object' && !Array.isArray(last.params) ? (last.params as Record<string, unknown>) : null,
    costSource: COST_SOURCES.includes(last.cost_source as CostSource) ? (last.cost_source as CostSource) : 'metered',
  };
}
