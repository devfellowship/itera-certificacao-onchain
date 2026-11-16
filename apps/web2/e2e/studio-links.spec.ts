/**
 * Click-through of the studio compatibility links, forward and way back (plan 20261112-tma-c5-studio-area-web2,
 * task C5-FIX-LINKS, Verification row 3: "e2e clicks each link of the compatibility table and its way back; none
 * lands on the 404 page").
 *
 *   forward   /agents -> S8 | /agents/:aid -> S5, S6 | /evaluations row -> S6
 *   way back  S5 -> /agents/:aid | S6 -> /agents/:aid | S8 agent row -> /agents/:aid
 *
 * Every hop: the URL is the target, the app root is non-empty (MOUNT), the target page's own root is visible, and the
 * 404 page is absent. The auto `pageErrors` fixture of helpers.ts asserts zero `pageerror` events (NO ERRORS) over the
 * whole test. CONTROL: the persistent smoke fixture of studio-fixture.ts holds data, so S8 lists the fixture agent and
 * /evaluations holds a row. The run-page Trajectory tab is NOT part of this spec: it was dropped from the table
 * (Q-C5-TRAJ = A). No screenshot and no trace: the spec types a password.
 */
import type { Page } from '@playwright/test'
import { expect, expectMounted, loginWithDfl, test } from './helpers'
import { FIXTURE_USE_CASE, ensureStudioFixture } from './studio-fixture'

/** One hop: click the link, then prove where it landed. */
async function hop(page: Page, linkTestId: string, urlPattern: RegExp, landedTestId: string): Promise<void> {
  const link = page.getByTestId(linkTestId).first()
  await expect(link, `link ${linkTestId}`).toBeVisible({ timeout: 30_000 })
  await link.click()
  await expect(page, `URL after ${linkTestId}`).toHaveURL(urlPattern)
  await expectMounted(page)
  await expect(page.getByTestId(landedTestId), `page ${landedTestId} after ${linkTestId}`).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('not-found'), `404 page after ${linkTestId}`).toHaveCount(0)
}

/** Open a page by URL and prove that it mounted and is not the 404 page. */
async function open(page: Page, url: string, readyTestId: string): Promise<void> {
  await page.goto(url)
  await expectMounted(page)
  await expect(page.getByTestId(readyTestId), `page ${readyTestId} at ${url}`).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('not-found'), `404 page at ${url}`).toHaveCount(0)
}

test('studio compatibility links work forward and way back, no 404, no page error', async ({ page }) => {
  await loginWithDfl(page)
  // The API base comes from the bundle's own GET /eval-cases, as in studio.spec.ts.
  const listCall = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/eval-cases'), { timeout: 30_000 })
  await page.goto('/studio')
  const resp = await listCall
  expect(resp.status(), 'GET /eval-cases from the studio home').toBe(200)
  const apiBase = (process.env.E2E_API_URL || resp.url().slice(0, resp.url().lastIndexOf('/eval-cases'))).replace(/\/+$/, '')
  const fixture = await ensureStudioFixture(page, apiBase)

  // Way back from S5: the base agent of the fixture links to its page. This also gives the agent id.
  await open(page, `/studio/experiments/new?case=${fixture.caseId}`, 'studio-experiment-page')
  const agentLink = page.getByTestId('experiment-agent-link').first()
  await expect(agentLink, 'S5 agent link (CONTROL: the fixture agent)').toBeVisible({ timeout: 30_000 })
  const agentPath = await agentLink.getAttribute('href')
  expect(agentPath, 'S5 agent link href').toMatch(/^\/agents\/[^/]+$/)
  await hop(page, 'experiment-agent-link', /\/agents\/[^/]+$/, 'studio-variants')

  // Forward from /agents/:aid: S5 and S6 filtered by the agent, each with its way back.
  await hop(page, 'studio-variants', /\/studio\/experiments\/new\?agent=/, 'studio-experiment-page')
  await hop(page, 'experiment-agent-link', /\/agents\/[^/]+$/, 'studio-variants')
  await hop(page, 'studio-experiments', /\/studio\/experiments\?agent=/, 'studio-experiments-page')
  await hop(page, 's6-agent-link', /\/agents\/[^/]+$/, 'studio-variants')

  // Forward from /agents: S8, then the way back from an S8 agent row.
  await open(page, '/agents', 'studio-compare-use-case')
  await hop(page, 'studio-compare-use-case', /\/studio\/compare$/, 'studio-compare')
  await open(page, `/studio/compare?use_case=${encodeURIComponent(FIXTURE_USE_CASE)}`, 'studio-compare')
  await expect(page.getByTestId('s8-row').first(), 'S8 agent row (CONTROL: the fixture agent)').toBeVisible({ timeout: 30_000 })
  await hop(page, 's8-agent-link', /\/agents\/[^/]+$/, 'studio-variants')

  // Forward from an /evaluations row to S6 (CONTROL: the smoke user has the fixture evaluations).
  await open(page, '/evaluations', 'row-studio-experiments')
  await hop(page, 'row-studio-experiments', /\/studio\/experiments\?agent=/, 'studio-experiments-page')
})
