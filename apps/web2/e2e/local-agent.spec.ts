/**
 * L11 of plan 20261026-tma-local-runner-and-self-declared-results: the "New local agent" form on the deployed site.
 * Read-only: the spec opens the form and reads GET /model-options through the UI. It NEVER submits (no data written in production).
 * The three assertions of "verified in prod": MOUNT, NO ERRORS (fixture), CONTROL (the selects hold real options).
 */
import { expect, expectMounted, loginWithDfl, test } from './helpers'

const ROUTE_KEYS = ['openrouter', 'opencode-go', 'ollama', 'zai', 'codex', 'claude-code', 'minimax']

test('New local agent form: mounted, filled from /model-options, never submitted', async ({ page }) => {
  await loginWithDfl(page)

  await page.goto('/agents/new?source=local')
  // 1. MOUNT
  await expectMounted(page)
  await expect(page.getByTestId('local-agent-form')).toBeVisible()
  await expect(page.getByTestId('add-agent-page')).toHaveAttribute('data-source', 'local')

  // 3. CONTROL: the selects are filled from the live API. The first provider/model option is the placeholder.
  const providerOptions = page.getByTestId('local-provider-select').locator('option')
  await expect(providerOptions).not.toHaveCount(1, { timeout: 30_000 })
  const providerCount = await providerOptions.count()
  expect(providerCount - 1, 'providers in GET /model-options').toBeGreaterThanOrEqual(5)

  const modelOptions = page.getByTestId('local-model-select').locator('option')
  expect((await modelOptions.count()) - 1, 'models in GET /model-options').toBeGreaterThanOrEqual(1)

  const routeOptions = page.getByTestId('local-route-select').locator('option')
  await expect(routeOptions).toHaveCount(ROUTE_KEYS.length)
  const routeValues = await routeOptions.evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value))
  expect(routeValues.sort()).toEqual([...ROUTE_KEYS].sort())

  // The submit button stays disabled with an empty name: nothing is written.
  await expect(page.getByTestId('create-local-agent')).toBeDisabled()
  expect(page.url()).toContain('/agents/new')
})
