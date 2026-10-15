/**
 * V6 of plan 20261015-testmyagent-web2-client: one free BYOK run reaches `graded` and shows a score.
 *
 * It starts ONE evaluation of the sample agent on one task, with the cheapest model and the capped
 * OpenRouter e2e key. The key is typed through a DOM write, not `fill()`, so no Playwright call log can
 * echo it. The spec never prints it. An evaluation cannot be deleted through the API, so the spec cancels
 * its own evaluation when it stops before the end state.
 */
import { expect, expectMounted, loginWithDfl, requireEnv, test } from './helpers'

const MODEL = process.env.E2E_MODEL || 'deepseek/deepseek-v4.1-flash'
const TASK_NAME = process.env.E2E_TASK_NAME || 'Duplicate settlement webhook'
const END_STATES = ['graded', 'failed', 'cancelled', 'review', 'issued']
const GRADE_TIMEOUT_MS = 15 * 60 * 1000

test('free BYOK run: start, wait for graded, score is shown', async ({ page }) => {
  const key = requireEnv('E2E_OPENROUTER_KEY')
  await loginWithDfl(page)

  await page.goto('/evaluate')
  await expectMounted(page)

  // Agent: the sample agent (no GitHub install needed).
  const sample = page.locator('[data-testid=agent-option][data-kind=sample]').first()
  await expect(sample).toBeVisible({ timeout: 30_000 })
  await sample.click()

  // Model: the cheapest one. Fall back to the default if the catalog dropped it.
  const modelSelect = page.getByTestId('model-select')
  const hasModel = (await modelSelect.locator(`option[value="${MODEL}"]`).count()) > 0
  if (hasModel) await modelSelect.selectOption(MODEL)

  // Task: one task.
  const taskLabel = page.locator('label', { hasText: TASK_NAME }).locator('[data-testid=task-option]')
  await expect(taskLabel).toHaveCount(1)
  await taskLabel.check()

  // Key: DOM write (React-compatible), then the "Check key" probe, which must accept it.
  await page.getByTestId('model-key-input').evaluate((el, value) => {
    const input = el as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, key)
  await page.getByTestId('model-key-check').click()
  await expect(page.getByTestId('model-key-ok')).toBeVisible({ timeout: 30_000 })

  // Start: exactly one run.
  const start = page.getByTestId('start-evaluation')
  await expect(start).toBeEnabled()
  await expect(start).toHaveText(/^Start evaluation$/)
  await start.click()
  await page.waitForURL(/\/evaluations\/[^/]+$/, { timeout: 60_000 })
  const evaluationId = page.url().split('/').pop()!
  expect(evaluationId.length).toBeGreaterThan(8)

  const status = page.getByTestId('evaluation-status')
  try {
    // Wait for an end state, then require `graded`.
    await expect
      .poll(async () => (await status.getAttribute('data-status')) ?? '', {
        timeout: GRADE_TIMEOUT_MS,
        intervals: [3_000, 5_000, 10_000],
        message: 'evaluation did not reach an end state in 15 minutes',
      })
      .toMatch(new RegExp(`^(${END_STATES.join('|')})$`))
    await expect(status).toHaveAttribute('data-status', 'graded')
  } catch (err) {
    // Do not leave a running evaluation behind.
    // The cancel button asks window.confirm; accept it.
    page.once('dialog', (d) => void d.accept())
    const cancel = page.getByTestId('cancel-evaluation')
    if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => undefined)
    throw err
  }

  // CONTROL (positive data): a numeric score_total, on the roll-up and on the run row.
  const total = page.getByTestId('score-total')
  await expect(total).toHaveText(/^\d+(\.\d+)?$/)
  const rows = page.getByTestId('run-row')
  await expect(rows).toHaveCount(1)
  await expect(page.getByTestId('run-score')).toHaveText(/^\d+(\.\d+)?$/)
  // A web2 evaluation ends at graded: no proof, no verify link.
  await expect(page.getByRole('link', { name: /verify|proof|nft/i })).toHaveCount(0)

  const score = await total.innerText()
  console.log(`free-run: evaluation ${evaluationId.slice(0, 8)} graded, score_total ${score}, model ${MODEL}`)

  // It also appears in "My evaluations".
  // The list links each evaluation by its full id; the short id is its first 8 characters.
  await page.getByTestId('nav-my-evaluations').click()
  await expect(page.locator(`a[href="/evaluations/${evaluationId}"]`)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid=evaluation-row]', { has: page.locator(`a[href="/evaluations/${evaluationId}"]`) })).toContainText(/graded/i)
})
