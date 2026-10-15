/**
 * "Login with DFL" entrypoint. The flow (ADR-2 of the plan):
 *   <federate>?return=<origin>/auth/dfl/callback&next=<path>
 *     -> DFL login on learn.devfellowship.com
 *     -> <origin>/auth/dfl/callback with the DFL token in the URL fragment
 *     -> POST {API}/auth/dfl/exchange
 * The URL builder lives in `../config` (one place for the VITE_* values).
 */
import { buildFederateUrl } from '../config'

/** The federate URL for this origin. `next` is the path to open after login. */
export function federateUrlFor(next = '/', origin: string = window.location.origin): string {
  return buildFederateUrl(origin, undefined, next)
}

/** Send the browser to the DFL federate endpoint. */
export function loginWithDfl(
  next = '/',
  navigate: (url: string) => void = (url) => window.location.assign(url),
): void {
  navigate(federateUrlFor(next))
}
