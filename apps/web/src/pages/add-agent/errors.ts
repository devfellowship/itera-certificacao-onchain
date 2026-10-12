import { ApiError } from '../../lib/api'

/** A message the user can act on, from any error of the GitHub or agent calls. Never leaks a stack. */
export function describeError(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Your session expired. Connect your wallet again.'
    if (e.status === 404) return 'The repo is not connected to this wallet. Open "Manage on GitHub" and give the app access again.'
    if (e.status === 413) return e.message || 'The agent files are too large.'
    if (e.status === 422) return e.message || 'No agent files at this path.'
    if (e.status === 429) return 'Too many requests. Wait a moment and try again.'
    if (e.status === 502 || e.status === 503) return 'GitHub did not answer. Try again in a moment.'
    if (e.status >= 400 && e.status < 500) return e.message || fallback
    return fallback
  }
  if (e instanceof TypeError) return 'Could not reach the server. Check your connection and try again.'
  return fallback
}

/** Install flow errors of GET /github/callback. */
export function describeCallbackError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400) return 'The install link expired or is incomplete. Start again from Add agent.'
    if (e.status === 401) return 'Connect your wallet, then install the app again.'
    if (e.status === 403) return 'The GitHub account that approved the install cannot access this installation.'
    if (e.status === 404) return 'GitHub did not find this installation of the app.'
    if (e.status === 409) return 'This installation is already connected to another wallet.'
    if (e.status === 502 || e.status === 503) return 'GitHub did not answer. Try again in a moment.'
  }
  if (e instanceof TypeError) return 'Could not reach the server. Check your connection and try again.'
  return 'Could not connect GitHub. Try again.'
}
