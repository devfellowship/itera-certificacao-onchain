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
 *
 * Second test (task C5-ROW3-ROW12): the other links of the compatibility table that the product has built.
 *   S6 cell -> /evaluations/:eid -> S7 ("Compare with baseline") -> back to /evaluations/:eid
 *   /tasks/:slug -> S4 list filtered by the task ("Test cases from this task") -> back to /tasks/:slug
 *   S4 case -> /tasks/:slug (the task page of the case) | S1 -> /tasks
 * Not clicked, because the product has no such link: S5 "New agent" and S4 "Create a task" (rows of the table
 * that no PR built). A new link of the table needs a hop here in the same PR.
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

/** Log in, read the API base from the bundle's own GET /eval-cases (as in studio.spec.ts) and ensure the fixture. */
async function loginAndFixture(page: Page) {
  await loginWithDfl(page)
  const listCall = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/eval-cases'), { timeout: 30_000 })
  await page.goto('/studio')
  const resp = await listCall
  expect(resp.status(), 'GET /eval-cases from the studio home').toBe(200)
  const apiBase = (process.env.E2E_API_URL || resp.url().slice(0, resp.url().lastIndexOf('/eval-cases'))).replace(/\/+$/, '')
  return ensureStudioFixture(page, apiBase)
}

test('studio compatibility links work forward and way back, no 404, no page error', async ({ page }) => {
  const fixture = await loginAndFixture(page)

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

  // Forward from an /evaluations row to S6 (CONTROL: the smoke user has the fixture evaluations). The testid is per
  // row by design: every evaluation row carries its own link to S6 filtered by its agent, so the page holds many.
  // The spec does not hide that with a blind .first(): it proves that the page lists at least one row link (CONTROL),
  // that EVERY row link targets S6 with an agent id, and only then clicks the first one.
  await page.goto('/evaluations')
  await expectMounted(page)
  const rowLinks = page.getByTestId('row-studio-experiments')
  await expect(rowLinks.first(), '/evaluations row link (CONTROL: at least one row)').toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('not-found'), '404 page at /evaluations').toHaveCount(0)
  const rowHrefs = await rowLinks.evaluateAll((els) => els.map((el) => el.getAttribute('href')))
  expect(rowHrefs.length, 'row links on /evaluations').toBeGreaterThan(0)
  for (const rowHref of rowHrefs) expect(rowHref, 'every /evaluations row link targets S6 for an agent').toMatch(/^\/studio\/experiments\?agent=[^&]+$/)
  await hop(page, 'row-studio-experiments', /\/studio\/experiments\?agent=/, 'studio-experiments-page')
})

/** The catalog task of task-tabs.spec.ts: a /tasks/:slug page that exists in production. */
const CATALOG_TASK = 'tsk_webhook_dup'

test('studio links from evaluations, tasks and S4 work forward and way back, no 404, no page error', async ({ page }) => {
  const fixture = await loginAndFixture(page)

  // S6 cell -> the evaluation page (canonical page of one evaluation). CONTROL: the skill cell of the fixture.
  await open(page, `/studio/experiments?case=${fixture.caseId}`, 's6-matrix')
  const skillCell = page.locator(`[data-testid="s6-cell"][data-variant="${fixture.skillVariantId}"]`)
  await expect(skillCell, 'S6 skill cell (CONTROL: the fixture variant)').toBeVisible({ timeout: 30_000 })
  await skillCell.getByTestId('s6-cell-link').click()
  await expect(page, 'URL after the S6 cell link').toHaveURL(/\/evaluations\/[^/?]+$/)
  await expectMounted(page)
  await expect(page.getByTestId('not-found'), '404 page after the S6 cell link').toHaveCount(0)
  const evaluationPath = new URL(page.url()).pathname

  // /evaluations/:eid -> S7 "Compare with baseline" (the skill variant is not the baseline), then the way back.
  await hop(page, 'studio-compare-baseline', /\/studio\/diff\?evaluation=/, 's7-table')
  expect(await page.locator('[data-testid="s7-row"]').count(), 'S7 rows (CONTROL)').toBeGreaterThanOrEqual(1)
  await hop(page, 's7-variant-evaluation-link', /\/evaluations\/[^/?]+$/, 'view-agent')
  expect(new URL(page.url()).pathname, 'way back lands on the same evaluation').toBe(evaluationPath)

  // /tasks/:slug -> S4 list filtered by the task, then the way back to the task page.
  await open(page, `/tasks/${CATALOG_TASK}`, 'task-profile')
  await hop(page, 'studio-task-cases', new RegExp(`/studio/cases\\?task=${CATALOG_TASK}$`), 'studio-task-filter')
  await page.getByTestId('studio-task-filter').getByRole('link', { name: CATALOG_TASK }).click()
  await expect(page, 'URL after the task link of S4').toHaveURL(new RegExp(`/tasks/${CATALOG_TASK}$`))
  await expectMounted(page)
  await expect(page.getByTestId('task-profile'), 'task page after the S4 way back').toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('not-found'), '404 page after the S4 way back').toHaveCount(0)

  // S4 case page -> the task page of the case (CONTROL: the fixture case holds its task slug).
  await open(page, `/studio/cases/${fixture.caseId}`, 'case-key')
  await expect(page.getByTestId('case-task-link'), 'S4 task link (CONTROL: the fixture case has a task)').toBeVisible({ timeout: 30_000 })
  await page.getByTestId('case-task-link').click()
  await expect(page, 'URL after the S4 task link').toHaveURL(/\/tasks\/[^/?]+$/)
  await expectMounted(page)
  await expect(page.getByTestId('not-found'), '404 page after the S4 task link').toHaveCount(0)

  // S1 -> /tasks (code tasks stay on the Tasks page).
  await page.goto('/studio')
  await expectMounted(page)
  await hop(page, 'studio-tasks-link', /\/tasks$/, 'tasks-page')
  // CONTROL: the Tasks page lists tasks (the testid is per row, so count, do not resolve one).
  await expect(page.getByTestId('task-author').first(), 'Tasks page row (CONTROL)').toBeVisible({ timeout: 30_000 })
})
