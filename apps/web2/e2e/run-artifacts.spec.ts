/**
 * L14c: the run artifacts page, logged in, against the deployed site.
 * From /evaluations open the first graded evaluation, take a runId from the API response of
 * GET /evaluations/:id, open /evaluations/{eid}/runs/{runId}, and assert the five tabs and that the
 * Log count is a number. Control (assertion 3 of "verified in prod"): the tabs row holds exactly
 * five tabs and the Log count parses as a number. Skips when the user has no graded evaluation.
 *
 * L17: the second test waits for the page's own GET /runs/:id/artifacts call (the API call, never the
 * SPA URL: see the fix of #170). When it answers 200 with a non-empty list, the Artifacts count is at
 * least that length and the first stored card renders (mounted, the fixture `pageErrors` holds zero
 * pageerror events). A 404 (not the owner, a legacy run, an API without the route) or an empty list
 * skips that part with a clear message.
 */
import type { Page, Response } from '@playwright/test'
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

/** The first graded run of the signed-in user: `{ eid, runId }`, or null (the test then skips with the reason). */
async function firstGradedRun(page: Page): Promise<{ eid: string; runId: string } | { skip: string }> {
  // The evaluation list: pick the first graded evaluation from the API body of GET /evaluations.
  const listResponse = page.waitForResponse((r) => isApiGet(r, /\/evaluations\/?$/))
  await page.goto('/evaluations')
  await expectMounted(page)
  const list = (await (await listResponse).json()) as { evaluations: Array<{ id: string; status: string }> }
  const graded = list.evaluations.find((e) => e.status === 'graded' || e.status === 'issued')
  if (!graded) return { skip: 'This user has no graded evaluation: nothing to open. Run a free evaluation first.' }
  const eid = graded.id

  // The evaluation page: the runId comes from the API body of GET /evaluations/:id.
  const detailResponse = page.waitForResponse((r) => isApiGet(r, new RegExp(`/evaluations/${eid}/?$`)))
  await page.goto(`/evaluations/${eid}`)
  await expectMounted(page)
  const detail = (await (await detailResponse).json()) as { tasks: Array<{ runId: string; stage: string }> }
  const run = detail.tasks.find((t) => t.stage === 'graded') ?? detail.tasks[0]
  if (!run) return { skip: 'The graded evaluation has no run.' }
  return { eid, runId: run.runId }
}

test('run artifacts page: five tabs, Log count is a number', async ({ page }) => {
  await loginWithDfl(page)
  const target = await firstGradedRun(page)
  test.skip('skip' in target, 'skip' in target ? target.skip : '')
  const { eid, runId } = target as { eid: string; runId: string }

  await page.goto(`/evaluations/${eid}/runs/${runId}`)
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

/** L17: the stored outputs of a hosted run, as GET /runs/:id/artifacts lists them. */
type StoredList = { reason: string | null; artifacts: Array<{ path: string; kind: string; bytes: number }> }

test('run artifacts page: the stored outputs render (L17)', async ({ page }) => {
  await loginWithDfl(page)
  const target = await firstGradedRun(page)
  test.skip('skip' in target, 'skip' in target ? target.skip : '')
  const { eid, runId } = target as { eid: string; runId: string }

  // Arm the wait BEFORE the navigation: the page calls GET /runs/:id/artifacts on load (the API call, not the SPA URL).
  const artifactsResponse = page.waitForResponse((r) => isApiGet(r, new RegExp(`/runs/${runId}/artifacts/?$`)), { timeout: 60_000 })
  await page.goto(`/evaluations/${eid}/runs/${runId}`)
  await expectMounted(page)
  await expect(page.getByTestId('run-tabs')).toBeVisible({ timeout: 30_000 })
  const res = await artifactsResponse
  test.skip(res.status() === 404, `GET /runs/${runId}/artifacts answered 404: not the owner, a legacy run, or an API without the route. The L14c list is shown instead.`)
  expect(res.status(), 'GET /runs/:id/artifacts status').toBe(200)
  const body = (await res.json()) as StoredList
  test.skip(body.artifacts.length === 0, `GET /runs/${runId}/artifacts holds no file (reason: ${body.reason ?? 'null'}). Nothing stored to render.`)

  // Control 1: the Artifacts count is at least the number of stored files.
  const tabs = page.locator('[data-testid="run-tabs"] [role="tab"]')
  const count = Number(await tabs.filter({ hasText: 'Artifacts' }).locator('.tma-tab__count').textContent())
  expect(Number.isFinite(count)).toBe(true)
  expect(count).toBeGreaterThanOrEqual(body.artifacts.length)

  // Control 2: the first stored card is on the Artifacts tab, loads its bytes, and renders a body by its kind.
  await tabs.filter({ hasText: 'Artifacts' }).first().click()
  await expect(page).toHaveURL(/tab=artifacts/)
  await expect(page.getByTestId('tab-artifacts')).toBeVisible()
  const stored = page.locator('[data-testid="tab-artifacts"] .ra-card[data-source="stored"]')
  await expect(stored.first()).toBeVisible({ timeout: 30_000 })
  expect(await stored.count()).toBeGreaterThanOrEqual(1)
  const first = stored.first()
  if ((await first.getAttribute('data-open')) !== 'true') await first.getByTestId('artifact-toggle').click()
  await expect(first).toHaveAttribute('data-load', 'ok', { timeout: 60_000 })
  await expect(first.getByTestId('artifact-error')).toHaveCount(0)
  const kind = await first.getAttribute('data-kind')
  const bodySelector = kind === 'html' ? 'iframe[sandbox=""]' : kind === 'json' ? '[data-testid="json-tree"], [data-testid="json-view"]' : kind === 'image' ? 'img' : kind === 'ndjson' ? '[data-testid="trace-view"]' : kind === 'diff' ? '[data-testid="diff-view"]' : kind === 'markdown' ? '[data-testid="markdown-view"]' : '[data-testid="text-view"]'
  await expect(first.locator(bodySelector).first()).toBeVisible({ timeout: 30_000 })
  await expect(first.getByTestId('artifact-download')).toBeEnabled()
  // No blob: or data:text/html anchor anywhere: the HTML preview is the sandboxed iframe; the download is a click, not a link.
  await expect(page.locator('a[href^="blob:"], a[href^="data:text/html"]')).toHaveCount(0)
})
