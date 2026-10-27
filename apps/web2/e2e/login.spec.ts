/**
 * V5 of plan 20261015-testmyagent-web2-client: a DFL user logs in on the web2 client.
 * The three assertions of "verified in prod": MOUNT, NO ERRORS (fixture), CONTROL (positive data).
 */
import { expect, expectMounted, loginWithDfl, test } from './helpers'

test('Login with DFL through the federation handoff', async ({ page }) => {
  // Logged out: the page mounts and offers exactly one "Login with DFL" button (control before login).
  await page.goto('/')
  await expectMounted(page)
  await expect(page.getByTestId('login-dfl')).toHaveCount(1)

  const email = await loginWithDfl(page)

  // 1. MOUNT: the app root is still non-empty after the round trip.
  await expectMounted(page)
  // 3. CONTROL: the signed-in e-mail is shown, and the login button is gone.
  await expect(page.getByTestId('nav-user-email')).toHaveText(email, { ignoreCase: true })
  await expect(page.getByTestId('login-dfl')).toHaveCount(0)
  // The one-time DFL token must not stay in the address bar.
  expect(page.url()).not.toContain('dfl_token')

  // The session survives a reload.
  await page.reload()
  await expectMounted(page)
  await expect(page.getByTestId('nav-user-email')).toHaveText(email, { ignoreCase: true })

  // A signed-in page that needs the session renders its data (GET /evaluations is loaded with the bearer token;
  // the e2e user has graded evaluations). /evaluate no longer lists agents while web2 = ingested only (plan TMA L15).
  await page.goto('/evaluations')
  await expect(page.getByTestId('evaluation-row').first()).toBeVisible({ timeout: 30_000 })
})
