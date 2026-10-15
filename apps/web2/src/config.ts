/** The one config module of apps/web2. Every value reads a VITE_* variable and has a default. */

const trimSlash = (value: string) => value.replace(/\/+$/, '')

export const DEFAULT_API_URL = 'https://itera-agent-credentials-api.devfellowship.com'
export const DEFAULT_FEDERATE_URL = 'https://learn.devfellowship.com/auth/federate'

/** Base URL of the TestMyAgent API (no trailing slash). */
export const API_URL = trimSlash(import.meta.env.VITE_TMA_API_URL || DEFAULT_API_URL)

/** Base URL of the DFL federate endpoint (no query string). */
export const DFL_FEDERATE_URL = import.meta.env.VITE_DFL_FEDERATE_URL || DEFAULT_FEDERATE_URL

/** Route of this app that receives the DFL redirect (`pages/DflCallbackPage.tsx`). */
export const DFL_CALLBACK_PATH = '/auth/dfl/callback'

/**
 * The URL that starts Login with DFL:
 * `<federate>?return=<origin>/auth/dfl/callback&next=<next>` with the return value URL-encoded.
 * The default `next` is `/` and stays unencoded.
 */
export function buildFederateUrl(
  origin: string,
  federateUrl: string = DFL_FEDERATE_URL,
  next = '/',
): string {
  const returnUrl = encodeURIComponent(`${origin}${DFL_CALLBACK_PATH}`)
  return `${federateUrl}?return=${returnUrl}&next=${next === '/' ? '/' : encodeURIComponent(next)}`
}
