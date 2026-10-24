/**
 * Which lab made a model. Pure (no assets), so tests run it without a DOM.
 * The data lives in model-labs.json: add a lab there (and its logo in model-logos/), not here.
 */
import data from './model-labs.json'

export type Lab = { key: string; name: string; logo: string }
/** A lab key from model-labs.json (`anthropic`, `openai`, ..., or the fallback `generic`). */
export type ProviderKey = string

type LabEntry = Lab & { openrouter: string[]; patterns: string[] }
type CompiledLab = Lab & { authors: Set<string>; patterns: RegExp[] }

export const FALLBACK_LAB: Lab = data.fallback
const ROUTE_PREFIXES = new Set(data.routePrefixes.map((p) => p.toLowerCase()))
const COMPILED: CompiledLab[] = (data.labs as LabEntry[]).map((l) => ({
  key: l.key,
  name: l.name,
  logo: l.logo,
  authors: new Set(l.openrouter.map((a) => a.toLowerCase())),
  patterns: l.patterns.map((p) => new RegExp(p)),
}))

/** Every known lab, in match order (the fallback is not in this list). */
export const LABS: Lab[] = COMPILED.map(({ key, name, logo }) => ({ key, name, logo }))

/** Lab name by key, including the fallback. */
export const PROVIDER_NAME: Record<ProviderKey, string> = Object.fromEntries(
  [...LABS, FALLBACK_LAB].map((l) => [l.key, l.name]),
)

const pub = ({ key, name, logo }: CompiledLab): Lab => ({ key, name, logo })

/**
 * Lab of a model from whatever the caller has: a model id (`z-ai/glm-4.6`, `ollama/gemma4:12b`,
 * `opencode-go/deepseek-v4-pro`, `gpt-5.5`), a provider name, a display label. Unknown -> the fallback lab.
 */
export function labOf(m: { id?: string | null; provider?: string | null; label?: string | null }): Lab {
  const id = (m.id ?? '').trim().toLowerCase()
  const rawPrefix = id.includes('/') ? id.split('/')[0].replace(/^~/, '') : ''
  // A route prefix (ollama/, opencode-go/, ...) names where the model ran, not who made it.
  const prefix = ROUTE_PREFIXES.has(rawPrefix) ? '' : rawPrefix
  if (prefix) {
    const byAuthor = COMPILED.find((l) => l.authors.has(prefix))
    if (byAuthor) return pub(byAuthor)
  }
  // The id prefix is the strongest signal; then the provider field; then the full id; then the free-text label.
  for (const text of [prefix, m.provider, id, m.label]) {
    const s = (text ?? '').toLowerCase()
    if (!s) continue
    for (const lab of COMPILED) if (lab.patterns.some((re) => re.test(s))) return pub(lab)
  }
  return FALLBACK_LAB
}

/** Lab key of a model (see `labOf`). Unknown -> `generic`. */
export function providerOf(m: { id?: string | null; provider?: string | null; label?: string | null }): ProviderKey {
  return labOf(m).key
}
