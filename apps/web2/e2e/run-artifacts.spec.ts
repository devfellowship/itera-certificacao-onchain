/**
 * L14c: the run artifacts page, logged in, against the deployed site.
 * From /evaluations open the first graded evaluation, take a runId from the API response of
 * GET /evaluations/:id, open /evaluations/{eid}/runs/{runId}, and assert the five tabs and that the
 * Log count is a number. Control (assertion 3 of "verified in prod"): the tabs row holds exactly
 * five tabs and the Log count parses as a number. Skips when the user has no graded evaluation.
 */
import type { Response } from '@playwright/test'
import { expect, expectMounted, loginWithDfl, test } from './helpers'

/**
 * An API call (fetch/XHR), never the page document. The SPA route /evaluations/:id has the same
 * path as the API route, so a URL-only match also catches the HTML navigation (fixed 2026-10-27).
 */
function isApiGet(r: Response, path: RegExp): boolean {
  const type = r.request().resourceType()
  if (type !== 'fetch' && type !== 'xhr') return false
  if (r.request().method() !== 'GET') return false
  return path.test(new URL(r.url()).pathname)
}

test('run artifacts page: five tabs, Log count is a number', async ({ page }) => {
  await loginWithDfl(page)

  // The evaluation list: pick the first graded evaluation from the API body of GET /evaluations.
  const listResponse = page.waitForResponse((r) => isApiGet(r, /\/evaluations\/?$/))
  await page.goto('/evaluations')
  await expectMounted(page)
  const list = (await (await listResponse).json()) as { evaluations: Array<{ id: string; status: string }> }
  const graded = list.evaluations.find((e) => e.status === 'graded' || e.status === 'issued')
  test.skip(!graded, 'This user has no graded evaluation: nothing to open. Run a free evaluation first.')
  const eid = graded!.id

  // The evaluation page: the runId comes from the API body of GET /evaluations/:id.
  const detailResponse = page.waitForResponse((r) => isApiGet(r, new RegExp(`/evaluations/${eid}/?$`)))
  await page.goto(`/evaluations/${eid}`)
  await expectMounted(page)
  const detail = (await (await detailResponse).json()) as { tasks: Array<{ runId: string; stage: string }> }
  const run = detail.tasks.find((t) => t.stage === 'graded') ?? detail.tasks[0]
  test.skip(!run, 'The graded evaluation has no run.')

  await page.goto(`/evaluations/${eid}/runs/${run!.runId}`)
  await expectMounted(page)
  await expect(page.getByTestId('run-artifacts-page')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('run-tabs')).toBeVisible({ timeout: 30_000 })

  const tabs = page.locator('[data-testid="run-tabs"] [role="tab"]')
  await expect(tabs).toHaveCount(5)
  for (const label of ['Summary', 'Artifacts', 'Tests', 'Log', 'Patch']) {
    await expect(tabs.filter({ hasText: label }).first()).toBeVisible()
  }

  const logCount = tabs.filter({ hasText: 'Log' }).locator('.tma-tab__count')
  await expect(logCount).toBeVisible()
  const n = Number(await logCount.textContent())
  expect(Number.isFinite(n)).toBe(true)
  expect(n).toBeGreaterThanOrEqual(0)

  await tabs.filter({ hasText: 'Log' }).first().click()
  await expect(page).toHaveURL(/tab=log/)
  await expect(page.getByTestId('tab-log')).toBeVisible()
})
