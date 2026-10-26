/**
 * L14a: the public task page with tabs, logged out, against the deployed site.
 * Control (assertion 3 of "verified in prod"): tsk_webhook_dup is a catalog task with runs, and its
 * instruction starts with "Fix POST /events".
 */
import { expect, expectMounted, test } from './helpers'

test('task page: five tabs, runs count, runs table rows, input text', async ({ page }) => {
  await page.goto('/tasks/tsk_webhook_dup')
  await expectMounted(page)
  await expect(page.getByTestId('task-profile')).toBeVisible({ timeout: 30_000 })

  const tabs = page.locator('[data-testid="task-tabs"] [role="tab"]')
  await expect(tabs).toHaveCount(5)
  for (const label of ['Overview', 'Input', 'Expected output', 'Rubric', 'Runs']) {
    await expect(tabs.filter({ hasText: label }).first()).toBeVisible()
  }

  const runsCount = tabs.filter({ hasText: 'Runs' }).locator('.tma-tab__count')
  await expect(runsCount).toBeVisible()
  expect(Number(await runsCount.textContent())).toBeGreaterThan(0)

  const rows = page.locator('[data-testid="runs-table-row"]')
  await expect(rows.first()).toBeVisible()
  expect(await rows.count()).toBeGreaterThanOrEqual(1)

  await tabs.filter({ hasText: 'Input' }).first().click()
  await expect(page).toHaveURL(/tab=input/)
  await expect(page.getByTestId('instruction')).toContainText('POST /events')
})
