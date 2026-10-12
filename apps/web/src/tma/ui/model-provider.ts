/** Which provider made a model. Pure (no assets) so it runs under node --test. */
export type ProviderKey = 'anthropic' | 'openai' | 'google' | 'qwen' | 'deepseek' | 'zai' | 'kimi' | 'xai' | 'meta' | 'mistral' | 'generic'

export const PROVIDER_NAME: Record<ProviderKey, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  zai: 'Z.ai',
  kimi: 'Moonshot AI',
  xai: 'xAI',
  meta: 'Meta',
  mistral: 'Mistral AI',
  generic: 'Model',
}

// Order matters: the first match wins. Patterns run on the OpenRouter-style id ("z-ai/glm-4.6"), the provider name and the label.
const RULES: Array<[ProviderKey, RegExp]> = [
  ['anthropic', /anthropic|claude|fable|opus|sonnet|haiku/],
  ['openai', /openai|\bgpt|chatgpt|\bo[134](-|\b)|codex/],
  ['google', /google|gemini|gemma/],
  ['qwen', /qwen|alibaba|tongyi/],
  ['deepseek', /deepseek/],
  ['zai', /z-ai|z\.ai|\bzai\b|zhipu|\bglm/],
  ['kimi', /moonshot|kimi/],
  ['xai', /x-ai|\bxai\b|grok/],
  ['meta', /meta-llama|\bmeta\b|llama/],
  ['mistral', /mistral|mixtral|codestral|devstral|magistral/],
]

/** Provider of a model from whatever the caller has: OpenRouter id, provider name, display label. Unknown → `generic`. */
export function providerOf(m: { id?: string | null; provider?: string | null; label?: string | null }): ProviderKey {
  // The id prefix before "/" is the strongest signal; then the provider field; then the free-text label.
  for (const text of [m.id?.split('/')[0], m.provider, m.id, m.label]) {
    const s = (text ?? '').toLowerCase()
    if (!s) continue
    for (const [key, re] of RULES) if (re.test(s)) return key
  }
  return 'generic'
}

