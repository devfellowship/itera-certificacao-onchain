/**
 * S11 judge calibration and S11a AI judge on the deployed site (plan 20261112-tma-c6-judge-calibration, task C6-T6).
 *   forward   /studio -> S11 | /studio/graders -> S11 | S11 judge card -> S11a
 *   way back  S11a -> S11
 * Every hop: the URL is the target, the app root is non-empty (MOUNT), the page's own root is visible, the 404 page is
 * absent. The auto `pageErrors` fixture of helpers.ts asserts zero `pageerror` events (NO ERRORS). CONTROL: the two
 * judges are listed, and each card shows how many runs wait for a human label (the S13 upload holds at least 20 per judge).
 * The screens are read only: the page holds no Save text and no form field. A judge that has no calibration record yet
 * shows an empty state; the spec accepts both states and checks the bar text (90%) in both.
 * No screenshot and no trace: the spec types a password.
 */
import type { Page } from '@playwright/test'
import { expect, expectMounted, loginWithDfl, test } from './helpers'

const JUDGES = ['async-wait-lifecycle', 'external-block-handling']

async function hop(page: Page, linkTestId: string, urlPattern: RegExp, landedTestId: string): Promise<void> {
  const link = page.getByTestId(linkTestId).first()
  await expect(link, `link ${linkTestId}`).toBeVisible({ timeout: 30_000 })
  await link.click()
  await expect(page, `URL after ${linkTestId}`).toHaveURL(urlPattern)
  await expectMounted(page)
  await expect(page.getByTestId(landedTestId), `page ${landedTestId} after ${linkTestId}`).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('not-found'), `404 page after ${linkTestId}`).toHaveCount(0)
}

test('S11 and S11a render with both judges, link both ways, and hold no write control', async ({ page }) => {
  await loginWithDfl(page)

  await page.goto('/studio')
  await expectMounted(page)
  await hop(page, 'studio-calibration-link', /\/studio\/calibration$/, 'studio-calibration')

  // CONTROL: both judges, each with a count of runs to review.
  const cards = page.getByTestId('calibration-judge')
  await expect(cards, 'S11 judge cards (CONTROL)').toHaveCount(2, { timeout: 30_000 })
  for (const j of JUDGES) {
    const card = page.locator(`[data-testid="calibration-judge"][data-judge="${j}"]`)
    await expect(card, `card of ${j}`).toBeVisible()
    await expect(card.getByTestId('cal-to-review'), `runs to review of ${j} (CONTROL)`).toHaveText(/^[1-9]\d*$/, { timeout: 30_000 })
  }
  await expect(page.locator('main')).not.toContainText(/\bSave\b/i)
  await expect(page.locator('main input, main textarea, main select, main form')).toHaveCount(0)

  // S11 -> S11a for the first judge, then the way back.
  await page.locator(`[data-testid="calibration-judge"][data-judge="${JUDGES[0]}"]`).getByTestId('calibration-judge-link').click()
  await expect(page).toHaveURL(new RegExp(`/studio/calibration/${JUDGES[0]}$`))
  await expectMounted(page)
  await expect(page.getByTestId('judge-definition'), 'S11a definition').toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('judge-bar-text'), 'S11a bar text').toContainText('90%')
  await expect(page.getByTestId('cal-tpr-bar-text')).toHaveText('bar 90%')
  await expect(page.getByTestId('judge-command'), 'copy command').toBeVisible()
  await expect(page.locator('main')).not.toContainText(/\bSave\b/i)
  await expect(page.getByTestId('not-found')).toHaveCount(0)
  await hop(page, 'judge-back', /\/studio\/calibration$/, 'studio-calibration')

  // Compatibility link from the grader library.
  await page.goto('/studio/graders')
  await expectMounted(page)
  await hop(page, 'graders-calibration-link', /\/studio\/calibration$/, 'studio-calibration')
})
