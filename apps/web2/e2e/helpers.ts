import { expect, test as base, type Page } from '@playwright/test'

/** Read a required variable. The error names the variable and never its value. */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing environment variable ${name}`)
  return value
}

/**
 * `test` with assertion 2 of "verified in prod": zero `pageerror` events.
 * The listener is armed by the fixture BEFORE the spec calls `goto`, and the check runs after the spec.
 */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (err) => errors.push(err.message))
      await use(errors)
      expect(errors, 'pageerror events').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

/** Assertion 1: the app root is mounted and not empty. */
export async function expectMounted(page: Page): Promise<void> {
  await expect(page.locator('#root')).not.toBeEmpty()
  await expect(page.locator('#root > *').first()).toBeVisible()
}

/**
 * Login with DFL through the real federation handoff:
 * web2 login button -> learn.devfellowship.com/login (e-mail + password) -> /auth/federate -> /auth/dfl/callback -> web2.
 * The control is the signed-in e-mail in the nav, which exists only after `POST /auth/dfl/exchange` succeeded.
 */
export async function loginWithDfl(page: Page): Promise<string> {
  const email = requireEnv('E2E_DFL_EMAIL')
  const password = requireEnv('E2E_DFL_PASSWORD')
  await page.goto('/')
  await expectMounted(page)
  await page.getByTestId('login-dfl').click()
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.locator('button[type=submit]').click()
  await expect(page.getByTestId('nav-user-email')).toBeVisible({ timeout: 60_000 })
  return email
}
