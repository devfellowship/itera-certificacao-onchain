/**
 * Which route ran a model: OpenRouter, opencode go, a local Ollama, the Z.ai API, a CLI harness.
 * Pure (no assets). The data lives in @itera/contracts (packages/contracts/model-catalog/routes.json,
 * shared with apps/api): add a route there, not here.
 * Replaces the fixed text "via OpenRouter", which was wrong for every non-OpenRouter executor.
 */
import { DEFAULT_ROUTE, ROUTES, routeOf } from '@itera/contracts/model-catalog'
import type { ModelRoute } from '@itera/contracts/model-catalog'

export { DEFAULT_ROUTE, ROUTES, routeOf }
export type { ModelRoute }

/**
 * The route of a local agent (L11): its declared `routeKey` first, else the guess from the model id.
 * An unknown key falls back to the model-id guess, so an older client never shows an empty route.
 */
export function routeOfAgent(a: { routeKey?: string | null; model?: string | null }): ModelRoute {
  return ROUTES.find((r) => r.key === a.routeKey) ?? routeOf(a.model)
}
