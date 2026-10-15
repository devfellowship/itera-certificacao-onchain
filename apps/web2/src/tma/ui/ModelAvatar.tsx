import anthropic from './model-logos/anthropic.svg'
import openai from './model-logos/openai.svg'
import google from './model-logos/google.svg'
import qwen from './model-logos/qwen.svg'
import deepseek from './model-logos/deepseek.svg'
import zai from './model-logos/zai.svg'
import kimi from './model-logos/kimi.svg'
import xai from './model-logos/xai.svg'
import meta from './model-logos/meta.svg'
import mistral from './model-logos/mistral.svg'
import generic from './model-logos/generic.svg'

import { PROVIDER_NAME, providerOf, type ProviderKey } from './model-provider'

const LOGO: Record<ProviderKey, string> = { anthropic, openai, google, qwen, deepseek, zai, kimi, xai, meta, mistral, generic }

type Props = { model?: string | null; provider?: string | null; label?: string | null; size?: 14 | 16 | 18 | 20 | 24 | 28 }

/** Provider logo of a model in a small white rounded tile. Decorative: the model name is always printed next to it. */
export function ModelAvatar({ model, provider, label, size = 20 }: Props) {
  const key = providerOf({ id: model, provider, label })
  const mark = Math.round(size * 0.7)
  return (
    <span className="tma-model-avatar" data-provider={key} title={PROVIDER_NAME[key]} aria-hidden="true" style={{ width: size, height: size, borderRadius: Math.max(4, Math.round(size / 4)) }}>
      <img className="tma-model-avatar__mark" src={LOGO[key]} alt="" width={mark} height={mark} draggable={false} />
    </span>
  )
}

/** Avatar + model name on one line (tables, cards, summaries). */
export function ModelLabel({ model, provider, label, size = 20, className }: Props & { className?: string }) {
  return (
    <span className={['tma-model-label', className].filter(Boolean).join(' ')}>
      <ModelAvatar model={model} provider={provider} label={label} size={size} />
      <span className="tma-model-label__text">{label ?? model ?? '—'}</span>
    </span>
  )
}
