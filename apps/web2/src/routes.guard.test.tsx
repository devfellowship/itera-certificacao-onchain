// @vitest-environment jsdom
/**
 * Route-table guard (plan 20261112-tma-c5-studio-area-web2, ADR-1; task C5-T1).
 * Every route of apps/web2/src/routes.tsx on main @ fe3fe6d must still resolve, to the same page component
 * and under the same layout (the layout carries the session gate). Tainan's rule (Q-T15 = A): the studio is
 * added next to the old pages; no old page is removed, renamed or redirected.
 * A PR that removes or renames a route, or moves it to another layout, turns this test red.
 * To remove a page on purpose, a new decision is needed: edit this table in the same PR and cite the decision.
 */
import { matchRoutes, type RouteObject } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { routes } from './routes'

/** Layout chain below the session provider: '' = none (the page sits directly under the provider). */
const APP = 'AppLayout'
const OPEN = 'OpenAppLayout'
const PUBLIC = 'PublicLayout'

/** [route pattern, a concrete URL for it, page component, layout] — the table of fe3fe6d. */
const FE3FE6D: Array<[string, string, string, string]> = [
  ['/', '/', 'LandingPage', ''],
  ['/e/:slugOrHash', '/e/ana-agent', 'PublicProfilePage', ''],
  ['/tasks/:slug', '/tasks/webhook-dup', 'TaskProfilePage', ''],
  ['/agents', '/agents', 'AgentsPage', APP],
  ['/agents/new', '/agents/new', 'AddAgentPage', APP],
  ['/agents/:aid/evaluate', '/agents/a1/evaluate', 'SelectTasksPage', APP],
  ['/evaluations', '/evaluations', 'MyEvaluationsPage', APP],
  ['/evaluations/:eid', '/evaluations/e1', 'RunningEvaluationPage', APP],
  ['/evaluations/:eid/runs/:runId', '/evaluations/e1/runs/r1', 'RunArtifactsPage', APP],
  ['/tasks', '/tasks', 'TasksPage', APP],
  ['/tasks/new', '/tasks/new', 'TaskEditorPage', APP],
  ['/tasks/:id/edit', '/tasks/t1/edit', 'TaskEditorPage', APP],
  ['/settings/profile', '/settings/profile', 'ProfileSettingsPage', APP],
  ['/cli', '/cli', 'CliLoginPage', APP],
  ['/agents/:aid', '/agents/a1', 'AgentDetailPage', OPEN],
  ['/u/:username', '/u/ana', 'UserPage', OPEN],
  ['/connect/github/callback', '/connect/github/callback', 'GithubCallbackPage', OPEN],
  ['/evaluate', '/evaluate', 'NewEvaluationPage', OPEN],
  ['/login', '/login', 'LoginPage', OPEN],
  ['/auth/dfl/callback', '/auth/dfl/callback', 'DflCallbackPage', OPEN],
  ['*', '/no/such/page', 'NotFoundPage', PUBLIC],
]

function nameOf(route: RouteObject): string {
  const el = route.element as { type?: { name?: string } } | undefined
  return el?.type?.name ?? ''
}

/** Resolve a URL: the layout (first named layout below the provider) and the page (the leaf). */
function resolve(url: string): { page: string; layout: string; pattern: string } {
  const m = matchRoutes(routes, url)
  expect(m, `no route matches ${url}`).not.toBeNull()
  const chain = m!.map((x) => nameOf(x.route))
  const layout = chain.slice(0, -1).find((n) => n.endsWith('Layout')) ?? ''
  const leaf = m![m!.length - 1]!.route
  return { page: nameOf(leaf), layout, pattern: leaf.path ?? '' }
}

describe('route-table guard: every route of fe3fe6d still resolves', () => {
  it.each(FE3FE6D)('%s -> %s', (pattern, url, page, layout) => {
    const r = resolve(url)
    expect(r.page).toBe(page)
    expect(r.layout).toBe(layout)
    expect(r.pattern).toBe(pattern)
  })

  it('the table has 21 entries and every pattern in routes.tsx is either in it or under /studio', () => {
    expect(FE3FE6D).toHaveLength(21)
    const patterns: string[] = []
    const walk = (list: RouteObject[]) => {
      for (const r of list) {
        if (r.path) patterns.push(r.path)
        if (r.children) walk(r.children)
      }
    }
    walk(routes)
    const known = new Set(FE3FE6D.map((r) => r[0]))
    const added = patterns.filter((p) => !known.has(p))
    // A new route is allowed only inside the studio area (ADR-1). Anything else needs its own decision.
    expect(added.filter((p) => !(p === '/studio' || p.startsWith('/studio/')))).toEqual([])
  })

  it('studio routes sit under AppLayout (same nav, same session gate)', () => {
    const r = resolve('/studio')
    expect(r.page).toBe('StudioHomePage')
    expect(r.layout).toBe(APP)
  })
})
