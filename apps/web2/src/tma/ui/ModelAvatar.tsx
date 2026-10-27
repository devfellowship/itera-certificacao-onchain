import { FALLBACK_LAB, LABS, labOf } from './model-provider'

// Every vendored logo, by file name. A new lab needs only its labs.json entry (packages/contracts/model-catalog/) and its SVG file.
const LOGO_URLS = import.meta.glob<string>('./model-logos/*.svg', { eager: true, query: '?url', import: 'default' })
const logoUrl = (file: string) => LOGO_URLS[`./model-logos/${file}`] ?? LOGO_URLS[`./model-logos/${FALLBACK_LAB.logo}`]

type Props = { model?: string | null; provider?: string | null; label?: string | null; size?: 14 | 16 | 18 | 20 | 24 | 28 }

/** Lab logo of a model in a small white rounded tile. Decorative: the model name is always printed next to it. */
/**
 * The lab of a model. An exact lab key in `provider` (a local agent's declared `providerKey`, L11) wins over
 * the guess from the model id: `labOf` reads the id prefix first, so `acme/mystery-7b` + `deepseek` would
 * otherwise fall back to the generic logo. A provider that is not a lab key goes through `labOf` as before.
 */
export function labOfModel({ model, provider, label }: Pick<Props, 'model' | 'provider' | 'label'>) {
  return LABS.find((l) => l.key === provider) ?? labOf({ id: model, provider, label })
}

export function ModelAvatar({ model, provider, label, size = 20 }: Props) {
  const lab = labOfModel({ model, provider, label })
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
