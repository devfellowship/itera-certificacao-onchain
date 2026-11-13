/**
 * Studio screens on the deployed site (plan 20261112-tma-c5-studio-area-web2, acceptance of C5-T3, C5-T4, C5-T5).
 *   S1  /studio                        the fixture case under the use case group `verify`
 *   S4  /studio/cases/:id              task summary (Before + Expected, no Outcome), 2 variants, copy command
 *   S5  /studio/experiments/new?case=  variants and runs, copy command
 *   S6  /studio/experiments?case=      matrix cells and the verdict of the skill variant
 *   S7  /studio/diff?case=&base=&variant=   rows per data type
 *   S10 /studio/graders, S10a detail   the fixture grader row; the detail has a copy command
 * Every page: MOUNT, NO ERRORS (the auto `pageErrors` fixture of helpers.ts), CONTROL (positive data).
 * Studio v1 is READ ONLY (ADR-5): each page also asserts that no Save / Run style control exists.
 *
 * PERSISTENT FIXTURE — WRITES TO PRODUCTION ON PURPOSE. The studio shows only the caller's own uploads, so the
 * DFL smoke user owns one test case `studio-smoke-fixture` (use case verify/prod-verify), one local agent
 * "studio smoke fixture agent", the private local task `studio-smoke-fixture-task`, two variants (baseline +
 * skill, 5 runs each) and the grader version studio-smoke-fixture-grader@1.0.0. This is the "fixture known to hold
 * data" of the prod render checks. It is NOT deleted at the end. The ensure step uploads only when the case is
 * missing or incomplete, so a nightly run makes no second upload. Detail: studio-fixture.ts.
 *
 * API base URL: E2E_API_URL when set, else read from the request that the deployed bundle sends to GET /eval-cases.
 */
import type { Page } from '@playwright/test'
import { expect, expectMounted, loginWithDfl, test } from './helpers'
import {
  FIXTURE_CASE_KEY,
  FIXTURE_GRADER_ID,
  FIXTURE_SKILL_LABEL,
  apiCall,
  ensureStudioFixture,
  type Fixture,
} from './studio-fixture'

/** Studio v1 has no write and no run control (ADR-5). Exact names: the "Runs" headings must not match "Run". */
const FORBIDDEN_CASE_CONTROLS = ['Save', 'Save case', 'Save draft', 'Save variant', 'Save as', 'Start an experiment', 'Run']
const FORBIDDEN_GRADER_CONTROLS = ['Save as', 'Duplicate', 'Plant another bug', 'Run']

async function expectNoControls(page: Page, names: string[]): Promise<void> {
  for (const name of names) {
    await expect(page.getByRole('button', { name, exact: true }), `button "${name}"`).toHaveCount(0)
    await expect(page.getByRole('link', { name, exact: true }), `link "${name}"`).toHaveCount(0)
  }
}

/** Open /studio, read the API base from the bundle's GET /eval-cases, and ensure the fixture. */
async function openStudioWithFixture(page: Page): Promise<{ apiBase: string; fixture: Fixture }> {
  await loginWithDfl(page)
  const listCall = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/eval-cases'),
    { timeout: 30_000 },
  )
  await page.goto('/studio')
  const resp = await listCall
  expect(resp.status(), 'GET /eval-cases from the studio home').toBe(200)
  const fromBundle = resp.url().slice(0, resp.url().lastIndexOf('/eval-cases'))
  const apiBase = (process.env.E2E_API_URL || fromBundle).replace(/\/+$/, '')
  const fixture = await ensureStudioFixture(page, apiBase)
  return { apiBase, fixture }
}

test('studio S1, S4, S5, S6, S7 render the persistent smoke fixture, read only', async ({ page }) => {
  const { fixture } = await openStudioWithFixture(page)

  await test.step('S1 /studio: the fixture case under the use case group verify', async () => {
    // The fixture may be new (just uploaded): load the page again so the list holds it.
    await page.goto('/studio')
    await expectMounted(page)
    await expect(page.getByTestId('studio-home')).toBeVisible()
    const group = page.getByTestId('use-case-verify')
    await expect(group).toBeVisible({ timeout: 30_000 })
    await expect(group.getByTestId('studio-case-link').filter({ hasText: FIXTURE_CASE_KEY })).toBeVisible()
  })

  await test.step('S4 test case: Before + Expected, 2 variants, copy command, no Save/Run', async () => {
    await page.goto(`/studio/cases/${fixture.caseId}`)
    await expectMounted(page)
    await expect(page.getByTestId('case-key')).toHaveText(FIXTURE_CASE_KEY, { timeout: 30_000 })
    const summary = page.locator('[data-task-summary]')
    await expect(summary).toBeVisible()
    await expect(summary).toContainText('Before')
    await expect(summary).toContainText('Expected')
    await expect(summary).not.toContainText('Outcome')
    await expect(page.getByTestId('summary-before')).not.toHaveText('—')
    await expect(page.getByTestId('summary-expected')).not.toHaveText('—')
    await expect(page.getByTestId('case-variant')).toHaveCount(2)
    await expect(page.getByTestId('case-variant').filter({ hasText: FIXTURE_SKILL_LABEL })).toBeVisible()
    await expect(page.getByTestId('case-grader').filter({ hasText: FIXTURE_GRADER_ID })).toBeVisible()
    expect(await page.locator('[data-copy-command]').count(), 'copy commands on S4').toBeGreaterThanOrEqual(1)
    await expectNoControls(page, FORBIDDEN_CASE_CONTROLS)
  })

  await test.step('S5 experiment builder: variants and runs, copy command, no Save/Run', async () => {
    await page.goto(`/studio/experiments/new?case=${fixture.caseId}`)
    await expectMounted(page)
    await expect(page.getByTestId('studio-experiment-page')).toBeVisible()
    await expect(page.getByTestId('experiment-variant').first()).toBeVisible({ timeout: 30_000 })
    expect(await page.getByTestId('experiment-variant').count(), 'variants on S5').toBeGreaterThanOrEqual(2)
    expect(await page.getByTestId('experiment-cell').count(), 'case x variant rows on S5').toBeGreaterThanOrEqual(2)
    expect(await page.locator('[data-copy-command]').count(), 'copy commands on S5').toBeGreaterThanOrEqual(1)
    await expectNoControls(page, FORBIDDEN_CASE_CONTROLS)
  })

  await test.step('S6 experiment result: >= 2 cells and the verdict of the skill variant', async () => {
    await page.goto(`/studio/experiments?case=${fixture.caseId}`)
    await expectMounted(page)
    await expect(page.getByTestId('s6-matrix')).toBeVisible({ timeout: 30_000 })
    expect(await page.locator('[data-testid="s6-cell"]').count(), 's6 cells').toBeGreaterThanOrEqual(2)
    const skillCell = page.locator(`[data-testid="s6-cell"][data-variant="${fixture.skillVariantId}"]`)
    await expect(skillCell).toBeVisible()
    const verdict = skillCell.getByTestId('s6-verdict')
    await expect(verdict).toBeVisible()
    await expect(verdict).toContainText(/vs baseline: (better|worse|tie|no verdict)/)
    // The fixture scores (baseline 62-79, skill 91-100, 5 runs each) give "better" under case-compare.ts.
    await expect(verdict).toHaveAttribute('data-verdict', 'better')
    await expectNoControls(page, FORBIDDEN_CASE_CONTROLS)
  })

  await test.step('S7 result diff: >= 1 row', async () => {
    await page.goto(`/studio/diff?case=${fixture.caseId}&base=${fixture.baselineVariantId}&variant=${fixture.skillVariantId}`)
    await expectMounted(page)
    await expect(page.getByTestId('s7-table')).toBeVisible({ timeout: 30_000 })
    expect(await page.locator('[data-testid="s7-row"]').count(), 's7 rows').toBeGreaterThanOrEqual(1)
    await expectNoControls(page, FORBIDDEN_CASE_CONTROLS)
  })
})

test('studio S10 graders list and S10a grader detail show the fixture grader, read only', async ({ page }) => {
  const { apiBase } = await openStudioWithFixture(page)

  // C5-T5 ships S10/S10a and GET /grader-versions. Until that deploy, the API answers 404 and this test skips
  // with a clear reason instead of a false red. Once the route exists, every assertion below runs.
  const probe = await apiCall(page, apiBase, 'GET', '/grader-versions')
  test.skip(probe.status === 404, 'GET /grader-versions answers 404: C5-T5 (S10/S10a) is not deployed yet')
  expect(probe.status, `GET /grader-versions: ${probe.text.slice(0, 300)}`).toBe(200)

  await page.goto('/studio/graders')
  await expectMounted(page)
  const row = page.locator(`[data-testid="grader-row-${FIXTURE_GRADER_ID}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expectNoControls(page, FORBIDDEN_GRADER_CONTROLS)

  // S10a: the detail page of the grader, opened from its row.
  await row.getByRole('link').first().click()
  await expect(page).not.toHaveURL(/\/studio\/graders\/?$/)
  await expectMounted(page)
  await expect(page.getByText(FIXTURE_GRADER_ID).first()).toBeVisible({ timeout: 30_000 })
  // Wait for the detail itself: right after the SPA navigation the list page can still be on screen.
  await expect(page.getByTestId('studio-grader-detail')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-copy-command]').first(), 'copy command on S10a').toBeAttached({ timeout: 30_000 })
  await expectNoControls(page, FORBIDDEN_GRADER_CONTROLS)
})
