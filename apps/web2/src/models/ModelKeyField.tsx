/**
 * The BYOK OpenRouter key field (plan 20261015-testmyagent-web2-client, ADR-5, task T8).
 *
 * A password input and a "Check key" button. The button calls `POST /models/access {openrouterKey}`
 * and shows the key label and the credit left. The API never stores the key. This component never
 * logs the key and never writes it to storage: the parent holds it in memory only.
 */
import { useId, useState } from 'react'
import { useSession } from '../auth/session'

export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys'

export interface ModelKeyInfo {
  label: string | null
  limitRemaining: number | null
  isFreeTier: boolean | null
}

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'valid'; info: ModelKeyInfo }
  | { kind: 'error'; message: string }

const ERROR_TEXT: Record<string, string> = {
  model_key_required: 'Enter your OpenRouter API key.',
  model_key_invalid: 'OpenRouter does not accept this key. Copy it again from your OpenRouter account.',
  model_key_no_credit: 'This key has no credit left. Add credit on OpenRouter or use another key.',
  model_key_probe_unavailable: 'We cannot reach OpenRouter now. Try again in a minute.',
}

function creditText(info: ModelKeyInfo): string {
  if (info.limitRemaining === null) return 'No credit limit on this key.'
  return `Credit left: US$${info.limitRemaining.toFixed(2)}.`
}

export function ModelKeyField({
  value,
  onChange,
  onChecked,
}: {
  value: string
  onChange: (key: string) => void
  /** Called with the key info after a successful check (never with the key). */
  onChecked?: (info: ModelKeyInfo) => void
}) {
  const { apiFetch } = useSession()
  const inputId = useId()
  const [state, setState] = useState<CheckState>({ kind: 'idle' })

  async function check() {
    const key = value.trim()
    if (!key) {
      setState({ kind: 'error', message: ERROR_TEXT.model_key_required! })
      return
    }
    setState({ kind: 'checking' })
    let res: Response
    try {
      res = await apiFetch('/models/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openrouterKey: key }),
      })
    } catch {
      setState({ kind: 'error', message: ERROR_TEXT.model_key_probe_unavailable! })
      return
    }
    const body = (await res.json().catch(() => null)) as (Partial<ModelKeyInfo> & { code?: string }) | null
    if (res.status === 200 && body) {
      const info: ModelKeyInfo = {
        label: typeof body.label === 'string' ? body.label : null,
        limitRemaining: typeof body.limitRemaining === 'number' ? body.limitRemaining : null,
        isFreeTier: typeof body.isFreeTier === 'boolean' ? body.isFreeTier : null,
      }
      setState({ kind: 'valid', info })
      onChecked?.(info)
      return
    }
    const message = (body?.code && ERROR_TEXT[body.code]) || 'We cannot check this key now. Try again.'
    setState({ kind: 'error', message })
  }

  return (
    <div className="w2-keyfield" data-testid="model-key-field">
      <label htmlFor={inputId} className="w2-keyfield-label">
        OpenRouter API key
      </label>
      <div className="w2-keyfield-row">
        <input
          id={inputId}
          data-testid="model-key-input"
          className="w2-input tma-mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-or-v1-…"
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setState({ kind: 'idle' })
          }}
        />
        <button type="button" className="w2-btn" data-testid="model-key-check" disabled={state.kind === 'checking'} onClick={() => void check()}>
          {state.kind === 'checking' ? 'Checking…' : 'Check key'}
        </button>
      </div>
      <p className="w2-keyfield-why" data-testid="model-key-why">
        TestMyAgent is free. Your agent runs on your own OpenRouter key, so you pay only the model tokens it uses,
        directly to OpenRouter. We use the key for your runs only, keep it encrypted, and delete it when the runs end.{' '}
        <a href={OPENROUTER_KEYS_URL} target="_blank" rel="noreferrer">
          Get a key on OpenRouter
        </a>
        .
      </p>
      <div aria-live="polite">
        {state.kind === 'valid' && (
          <p className="w2-keyfield-ok" data-testid="model-key-ok">
            Key OK{state.info.label ? `: ${state.info.label}` : ''}. {creditText(state.info)}
            {state.info.isFreeTier ? ' This is a free-tier key: free models only.' : ''}
          </p>
        )}
        {state.kind === 'error' && (
          <p className="w2-keyfield-error" role="alert" data-testid="model-key-error">
            {state.message}
          </p>
        )}
      </div>
    </div>
  )
}
