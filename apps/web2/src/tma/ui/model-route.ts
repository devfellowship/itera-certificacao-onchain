/**
 * Which route ran a model: OpenRouter, opencode go, a local Ollama, the Z.ai API, a CLI harness.
 * Pure (no assets). The data lives in model-routes.json: add a route there, not here.
 * Replaces the fixed text "via OpenRouter", which was wrong for every non-OpenRouter executor.
 */
import data from './model-routes.json'

export type ModelRoute = { key: string; name: string }

const PREFIXES: Record<string, ModelRoute> = data.prefixes
export const DEFAULT_ROUTE: ModelRoute = data.default

/** Route of a model id (`opencode-go/deepseek-v4-pro`, `ollama/gemma4:12b`, `anthropic/claude-haiku-4.5`). Unknown or empty -> OpenRouter. */
export function routeOf(modelId?: string | null): ModelRoute {
  const id = (modelId ?? '').trim().toLowerCase()
  const prefix = id.includes('/') ? id.split('/')[0].replace(/^~/, '') : ''
  return Object.hasOwn(PREFIXES, prefix) ? PREFIXES[prefix] : DEFAULT_ROUTE
}
