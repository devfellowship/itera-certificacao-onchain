/**
 * Which route ran a model: OpenRouter, opencode go, a local Ollama, the Z.ai API, a CLI harness.
 * Pure (no assets). The data lives in @itera/contracts (packages/contracts/model-catalog/routes.json,
 * shared with apps/api): add a route there, not here.
 * Replaces the fixed text "via OpenRouter", which was wrong for every non-OpenRouter executor.
 */
export { DEFAULT_ROUTE, routeOf } from '@itera/contracts/model-catalog'
export type { ModelRoute } from '@itera/contracts/model-catalog'
