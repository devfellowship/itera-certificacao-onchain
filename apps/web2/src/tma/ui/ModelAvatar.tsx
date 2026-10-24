import { FALLBACK_LAB, labOf } from './model-provider'

// Every vendored logo, by file name. A new lab needs only its model-labs.json entry and its SVG file.
const LOGO_URLS = import.meta.glob<string>('./model-logos/*.svg', { eager: true, query: '?url', import: 'default' })
const logoUrl = (file: string) => LOGO_URLS[`./model-logos/${file}`] ?? LOGO_URLS[`./model-logos/${FALLBACK_LAB.logo}`]

type Props = { model?: string | null; provider?: string | null; label?: string | null; size?: 14 | 16 | 18 | 20 | 24 | 28 }

/** Lab logo of a model in a small white rounded tile. Decorative: the model name is always printed next to it. */
export function ModelAvatar({ model, provider, label, size = 20 }: Props) {
  const lab = labOf({ id: model, provider, label })
  const mark = Math.round(size * 0.7)
  return (
    <span className="tma-model-avatar" data-provider={lab.key} data-lab={lab.key} title={lab.name} aria-hidden="true" style={{ width: size, height: size, borderRadius: Math.max(4, Math.round(size / 4)) }}>
      <img className="tma-model-avatar__mark" src={logoUrl(lab.logo)} alt="" width={mark} height={mark} draggable={false} />
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
