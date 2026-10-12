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
}

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
  };
}
