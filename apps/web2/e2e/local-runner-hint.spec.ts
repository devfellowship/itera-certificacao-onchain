/**
 * L15b of plan TMA L15: web2 = ingested only for now (Tainan TG 23889). A Login with DFL session gets no hosted
 * run, so /evaluate shows the local-runner hint (tma login / tma run / tma upload) and no OpenRouter key input.
 * Read-only: the spec opens the page and reads it. It writes no data (no POST /evaluations, no key typed).
 * The three assertions of "verified in prod": MOUNT, NO ERRORS (fixture), CONTROL (the hint and its three commands).
 */
import { expect, expectMounted, loginWithDfl, test } from './helpers'

test('/evaluate shows the local-runner hint and no key input (web2 = ingested only)', async ({ page }) => {
  await loginWithDfl(page)

  await page.goto('/evaluate')
  // 1. MOUNT
  await expectMounted(page)

  // 3. CONTROL: the hint is there, with the three tma commands; the hosted form is not.
  const hint = page.getByTestId('local-runner-hint')
  await expect(hint).toBeVisible({ timeout: 30_000 })
  await expect(hint).toContainText('Run it on your machine')
  await expect(page.getByTestId('tma-cli-steps')).toBeVisible()
  await expect(page.getByTestId('tma-cli-run')).toContainText('tma run --task')
  await expect(hint).toContainText('tma upload result.json')
  await expect(page.getByTestId('local-runner-hint-new-agent')).toHaveAttribute('href', '/agents/new?source=local')

  await expect(page.locator('[data-testid=model-key-input]')).toHaveCount(0)
  await expect(page.locator('[data-testid=start-evaluation]')).toHaveCount(0)
  await expect(page.locator('[data-testid=agent-option]')).toHaveCount(0)

  // No horizontal page scroll at a phone width: the command lines scroll inside their own box.
  await page.setViewportSize({ width: 375, height: 800 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'horizontal page overflow at 375 px').toBeLessThanOrEqual(0)
  expect(page.url()).toContain('/evaluate')
})
