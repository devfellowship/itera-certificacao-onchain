/**
 * L14b: the review layout of a graded evaluation, logged in, against the deployed site.
 * Control (assertion 3 of "verified in prod"): the first graded evaluation of the e2e user. When the
 * user has none, the test skips with a clear message instead of a false green.
 */
import { expect, expectMounted, loginWithDfl, test } from './helpers'

test('evaluation page: big score, item navigator squares, expected-vs-agent rows', async ({ page }) => {
  await loginWithDfl(page)
  await page.goto('/evaluations')
  await expectMounted(page)
  await expect(page.getByTestId('my-evaluations')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="evaluations-list"], [data-testid="evaluations-empty"]').first()).toBeVisible({ timeout: 30_000 })

  const graded = page.locator('[data-testid="evaluation-row"]').filter({ has: page.locator('[data-testid="status-graded"]') })
  test.skip((await graded.count()) === 0, 'this user has no graded evaluation: nothing to review')

  await graded.first().locator('a').first().click()
  await expect(page).toHaveURL(/\/evaluations\/[0-9a-f-]+/)
  await expect(page.getByTestId('evaluation-review')).toBeVisible({ timeout: 30_000 })

  const score = page.getByTestId('review-score')
  await expect(score).toBeVisible()
  expect(await score.textContent()).toMatch(/^\d+(\.\d)?$/)

  const squares = page.locator('[data-testid="item-square"]')
  expect(await squares.count()).toBeGreaterThanOrEqual(1)
  await expect(page.locator('[data-testid="item-square"][data-current="true"]')).toHaveCount(1)

  const rows = page.locator('[data-testid="compare-row"]')
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  expect(await rows.count()).toBeGreaterThanOrEqual(1)
  await expect(page.getByTestId('artifacts-card')).toBeVisible()
})
