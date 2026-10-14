// Per-run model ROUTE (K10, plan 20261012-testmyagent-dfl-benchmark-tasks).
//
// The agent's model id picks the route:
//   - `opencode-go/<model>` → the opencode go subscription (https://opencode.ai/zen/go/v1). The run's
//     gateway adds OPENCODE_GO_API_KEY itself; the sandbox's opencode uses its built-in `opencode-go`
//     provider, pointed at the gateway (sandbox/opencode.json).
//   - anything else → OpenRouter, as before (`openrouter/<model>`).
//
// opencode go answers no USD cost per call (its `usage` has tokens only). The gateway then derives
// the cost from tokens × the price table below and marks it `derived` (plan risk R7).

export type RouteId = 'openrouter' | 'opencode-go';

/** USD per million tokens. `cacheRead` prices `prompt_tokens_details.cached_tokens`. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Where the numbers come from: the report cites it next to every derived cost. */
  source: string;
}

export interface ModelRoute {
  route: RouteId;
  /** The `-m` argument of opencode in the sandbox (`provider/model`). */
  opencodeModel: string;
  /** The model id that the upstream API sees. */
  upstreamModel: string;
  /** Gateway upstream origin and the only path prefix the gateway forwards. */
  upstream: string;
  pathPrefix: string;
  /** Price table entry for a derived cost; null on a route that reports cost itself (OpenRouter). */
  price: ModelPrice | null;
  /** opencode go refuses a request without `x-opencode-session` (MissingSessionID); the gateway adds one. */
  needsSessionHeader: boolean;
}

export const OPENCODE_GO_PREFIX = 'opencode-go/';
export const OPENCODE_GO_PATH_PREFIX = '/zen/go/v1/';
export const OPENROUTER_PATH_PREFIX = '/api/v1/';

/**
 * Prices of the models we run through opencode go. Source: the models.dev snapshot that
 * opencode-ai@1.18.31 bundles (`opencode models opencode-go --verbose`, read 2026-10-14 on the
 * TestMyAgent VPS). A model that is not listed here runs, but its cost is 0 and marked `unpriced`.
 */
export const OPENCODE_GO_PRICES: Readonly<Record<string, ModelPrice>> = {
  'deepseek-v4.1-flash': { input: 0.15, output: 0.6, cacheRead: 0.003, source: 'models.dev snapshot in opencode-ai@1.18.31 (2026-10-14)' },
};

const MODEL_RE = /^[A-Za-z0-9._:/~-]+$/;

export function routeOfModel(model: string, env: { openrouterUpstream: string; opencodeGoUpstream: string }): ModelRoute {
  if (!MODEL_RE.test(model)) throw new Error(`invalid model id: ${model}`);
  if (model.startsWith(OPENCODE_GO_PREFIX)) {
    const upstreamModel = model.slice(OPENCODE_GO_PREFIX.length);
    if (!upstreamModel || upstreamModel.includes('/')) throw new Error(`invalid opencode-go model id: ${model}`);
    return {
      route: 'opencode-go',
      opencodeModel: model,
      upstreamModel,
      upstream: env.opencodeGoUpstream,
      pathPrefix: OPENCODE_GO_PATH_PREFIX,
      price: OPENCODE_GO_PRICES[upstreamModel] ?? null,
      needsSessionHeader: true,
    };
  }
  const opencodeModel = model.startsWith('openrouter/') ? model : `openrouter/${model}`;
  return {
    route: 'openrouter',
    opencodeModel,
    upstreamModel: opencodeModel.slice('openrouter/'.length),
    upstream: env.openrouterUpstream,
    pathPrefix: OPENROUTER_PATH_PREFIX,
    price: null,
    needsSessionHeader: false,
  };
}
