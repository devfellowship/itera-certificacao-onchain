/** The one config module of apps/web2. Every value reads a VITE_* variable and has a default. */

const trimSlash = (value: string) => value.replace(/\/+$/, '')

export const DEFAULT_API_URL = 'https://itera-agent-credentials-api.devfellowship.com'
export const DEFAULT_FEDERATE_URL = 'https://learn.devfellowship.com/auth/federate'

/** Base URL of the TestMyAgent API (no trailing slash). */
export const API_URL = trimSlash(import.meta.env.VITE_TMA_API_URL || DEFAULT_API_URL)

/** Base URL of the DFL federate endpoint (no query string). */
export const DFL_FEDERATE_URL = import.meta.env.VITE_DFL_FEDERATE_URL || DEFAULT_FEDERATE_URL

/**
 * Hosted runs (POST /evaluations with your OpenRouter key) from this client.
 * web2 = ingested only for now (Tainan TG 23889). The API flag is TMA_WEB2_HOSTED_ENABLED; turn both on together.
 * Off (the default): every hosted-start surface shows the local-runner hint (`tma run` + `tma upload`) instead.
 */
export const HOSTED_RUNS_ENABLED = import.meta.env.VITE_TMA_WEB2_HOSTED === 'true'

/**
 * The fleet-wide trajectory wall: the `trajectory-wall` card of Decision Graph analytics. Studio S9 shows TMA runs
 * only (plan 20261112-tma-c9-trajectory-analytics ADR-6, Q-T20 = A) and links here for the fleet. Override with
 * VITE_TMA_FLEET_WALL_URL.
 */
export const DEFAULT_FLEET_WALL_URL = 'https://decisiongraph.devfellowship.com/analytics#/?card=trajectory-wall'
export const FLEET_WALL_URL = import.meta.env.VITE_TMA_FLEET_WALL_URL || DEFAULT_FLEET_WALL_URL

/**
 * Base URL of `tma studio serve` (plan 20261112-tma-c5-studio-area-web2, C5-T6/T10/T11), no trailing slash.
 * THE one base URL of the serve. Set: S2 (/studio/traces) and S3 (/studio/traces/:sessionId) read through it
 * (only via studio/traces.ts). Empty (the default): S2/S3 show "not configured" and the dry-run panel stays hidden.
 */
export const STUDIO_SERVE_URL = trimSlash(import.meta.env.VITE_TMA_STUDIO_SERVE_URL || '')

/**
 * The S10a "Try this grader (dry run)" panel (C5-T10) is a separate opt-in: it shows only when STUDIO_SERVE_URL is
 * set AND VITE_TMA_STUDIO_DRY_RUN is 'true'. Reason: the serve on the host has no `/grade/dry-run` route yet (it
 * answers 405), so setting the URL for S2/S3 must not surface a broken "Dry run" button. Default: off.
 */
export const DRY_RUN_ENABLED = import.meta.env.VITE_TMA_STUDIO_DRY_RUN === 'true'

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
