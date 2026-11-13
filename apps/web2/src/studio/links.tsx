/**
 * Compatibility links from the existing web2 pages to the studio screens
 * (plan 20261112-tma-c5-studio-area-web2, task C5-T2, ADR-1 and ADR-2).
 * A link to a screen that is not built yet is HIDDEN, not broken: `StudioLink` renders nothing while the
 * screen's `built` flag is false. The flag is checked against routes.tsx by a test (studio-links.test.tsx):
 * the PR that adds the route of a screen must also set `built: true`, or that test fails. That turns
 * the link on in every old page that carries it, with no other edit.
 * The paths below are the planned routes of the screens. Each screen's own PR may change its path here.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export type StudioScreen = 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10'

export const STUDIO_SCREENS: Record<StudioScreen, { path: string; built: boolean }> = {
  S4: { path: '/studio/cases', built: true },
  S5: { path: '/studio/experiments/new', built: true },
  S6: { path: '/studio/experiments', built: true },
  S7: { path: '/studio/diff', built: true },
  S8: { path: '/studio/compare', built: false },
  S9: { path: '/studio/trajectories', built: true },
  S10: { path: '/studio/graders', built: true },
}

type Params = Record<string, string | null | undefined>

/** Path of a studio screen with its query filter (empty values are dropped). */
export function studioHref(screen: StudioScreen, params: Params = {}): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v)
  const s = q.toString()
  return `${STUDIO_SCREENS[screen].path}${s ? `?${s}` : ''}`
}

type LinkProps = {
  screen: StudioScreen
  params?: Params
  children: ReactNode
  className?: string
  testId?: string
  /** Extra condition of the page (for example "this evaluation is not the baseline"). */
  when?: boolean
  /** Test seam: force the built state of the screen. */
  built?: boolean
}

/** A link to a studio screen; renders nothing while the screen does not exist. */
export function StudioLink({ screen, params, children, className, testId, when = true, built = STUDIO_SCREENS[screen].built }: LinkProps) {
  if (!built || !when) return null
  return (
    <Link to={studioHref(screen, params)} className={className} data-testid={testId} data-studio-link={screen}>
      {children}
    </Link>
  )
}
