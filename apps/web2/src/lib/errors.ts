/**
 * API error → user message, for the web2 evaluation flow (plan 20261015-testmyagent-web2-client, T9).
 * The API answers `{error, code?}`. The `code` (else the `error` text) selects the message.
 */

export interface ApiErrorBody {
  error?: string
  code?: string
  resetAt?: string
  [key: string]: unknown
}

export const UPGRADING_MESSAGE = 'Service is being upgraded. Try again in a few minutes.'

function formatResetAt(resetAt: unknown): string | null {
  if (typeof resetAt !== 'string') return null
  const t = Date.parse(resetAt)
  if (Number.isNaN(t)) return null
  return new Date(t).toLocaleString()
}

/** The message for a refused API call. Never includes a request value (a key never reaches this function). */
export function apiErrorMessage(status: number, body: ApiErrorBody | null): string {
  const code = body?.code ?? body?.error
  switch (code) {
    case 'model_key_required':
      return 'Enter your OpenRouter API key.'
    case 'model_key_invalid':
      return 'OpenRouter does not accept this key. Copy it again from your OpenRouter account.'
    case 'model_key_no_credit':
      return 'This key has no credit left. Add credit on OpenRouter or use another key.'
    case 'model_key_probe_unavailable':
      return 'We cannot reach OpenRouter now. Try again in a minute.'
    case 'quota_exceeded': {
      const at = formatResetAt(body?.resetAt)
      return `You used your daily evaluation quota.${at ? ` You can start new runs again at ${at}.` : ' Try again tomorrow.'}`
    }
    case 'too_many_queued':
      return 'You already have the maximum number of runs queued or running. Wait for them to finish.'
    case 'account_disabled':
      return 'Your account is disabled. Contact DFL support.'
    case 'schema_not_ready':
      return UPGRADING_MESSAGE
    case 'incompatible':
      return body?.error ?? 'The agent is not compatible with a selected task.'
  }
  if (status === 0) return 'We cannot reach the TestMyAgent API. Check your connection and try again.'
  if (status === 503) return UPGRADING_MESSAGE
  if (status === 404) return body?.error ? `Not found: ${body.error}.` : 'Not found.'
  if (status === 429) return body?.error ?? 'Too many requests. Wait a moment and try again.'
  if (body?.error) return body.error
  return `The request failed (HTTP ${status}). Try again.`
}
