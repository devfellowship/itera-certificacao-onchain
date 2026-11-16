/**
 * S13 review queue on the deployed site (plan 20261112-tma-c6-judge-calibration, task T3 acceptance).
 *   1. The label write: POST /grader-results/human on the review fixture run answers 201, and
 *      GET /grader-results/human?run_id= reads the same label back.
 *   2. /studio/review at 390 px: MOUNT, NO ERRORS (the auto `pageErrors` fixture), CONTROL (a review card with its
 *      position and the judge question; the fixture guarantees at least one trace_review run in the tenant).
 * The 403 for a run of another tenant is an API test (apps/api human-labels.test.ts): production has one tenant.
 *
 * PERSISTENT FIXTURE — WRITES TO PRODUCTION ON PURPOSE. The smoke user owns one trace_review case
 * `studio-review-fixture` with one synthetic run (no grader rows of its own). The upload is deterministic, so a
 * second upload answers `unchanged`. Each run of this spec adds ONE smoke label on that run; a label cannot be deleted
 * through the API (grader_results has no DELETE route). The fixture case is in no calibration split.
 */
import { createHash } from 'node:crypto'
import { expect, expectMounted, loginWithDfl, test } from './helpers'
import { apiCall, ensureStudioFixture, jsonOf } from './studio-fixture'

const CASE_KEY = 'studio-review-fixture'
const JUDGE = 'async-wait-lifecycle'
const sha = (label: string) => createHash('sha256').update(`studio-review-fixture:${label}`).digest('hex')
const EMPTY_DIFF_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const MODEL = 'opencode-go/deepseek-v4-pro'

function step(seq: number, tool: string, kind: string, status = 'ok') {
  return {
    seq, parent_seq: null, turn: seq, tool, tool_family: tool === 'Bash' ? 'shell' : 'builtin', status, error_class: status === 'ok' ? null : 'tool_error',
    duration_ms: 500, tokens_in: null, tokens_out: null, target_kind: 'none', target_redacted: null,
    args_sha256: sha(`args:${seq}`), result_sha256: sha(`result:${seq}`), retry_of: null, step_kind: kind, started_ms: seq * 1000, turn_origin: seq === 1 ? 'human' : 'agent',
  }
}

function reviewBody(agentId: string): Record<string, unknown> {
  return {
    format: 'tma-local-result/3',
    agent_id: agentId,
    task: {
      local: {
        slug: 'studio-review-fixture-task', name: 'Studio review fixture task', description: 'Synthetic task of the S13 e2e fixture. No real run.',
        contract_sha256: sha('task-contract'), environment_sha256: sha('task-environment'), hidden_tests_sha256: sha('task-hidden-tests'),
      },
    },
    metrics_shape: 'tma-score/1',
    grader_version: '1.1.0',
    runner: { version: '0.1.0', execution: 'external', profile: null, sandbox_image_id: null },
    executor: { model_id: MODEL, provider: 'deepseek', route: 'opencode-go', harness: 'opencode 1.18.31', variant: null, cost_source: 'none' },
    ran_from: '2026-11-16T10:00:00Z',
    ran_to: '2026-11-16T10:20:00Z',
    summary: { score: 100, runs: 1, items: 1 },
    runs: [{
      item_sha256: sha('item'), repeat: 1, status: 'pass', score: 100, wall_s: 1200, cost_usd: null, tokens_in: null, tokens_out: null, error_class: null,
      parts: null, infra_ok: true, graders: [],
      trajectory: { format: 'tma-trajectory/2', steps: [step(1, 'Read', 'read'), step(2, 'Bash', 'shell', 'error'), step(3, 'Bash', 'test')] },
    }],
    case: {
      case_key: CASE_KEY, manifest_sha256: sha('case-manifest'), origin_pin_sha256: null, mode: 'trace_review', use_case_key: 'verify/prod-verify',
      task_summary: { before: 'A PR waits for CI after the push.', expected: 'The run starts a watcher, ends its turn and merges after the wake.' },
    },
    variant: {
      agent: { harness: 'opencode', harness_version: '1.18.31', harness_repo_sha: null, model_id: MODEL, rules_sha256: null, skills_sha256: null, mcp_manifest_sha256: null, tools_sha256: null },
      variant_sha256: EMPTY_DIFF_SHA256, label: 'recorded session', change_kind: 'none',
    },
    comparison: { is_baseline: true, prediction_sha256: null },
  }
}

test('S13: a label is written and read back, and /studio/review renders a card at 390 px', async ({ page }) => {
  await loginWithDfl(page)
  const listCall = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/eval-cases'), { timeout: 30_000 })
  await page.goto('/studio')
  const resp = await listCall
  const apiBase = (process.env.E2E_API_URL || resp.url().slice(0, resp.url().lastIndexOf('/eval-cases'))).replace(/\/+$/, '')
  await ensureStudioFixture(page, apiBase)
  const agents = jsonOf<{ agents: Array<{ id: string; name: string; connector?: string }> }>(await apiCall(page, apiBase, 'GET', '/agents?include=local'), 'GET /agents')
  const agentId = agents.agents.find((a) => a.name === 'studio smoke fixture agent' && a.connector === 'local')?.id
  expect(agentId, 'the studio fixture agent').toBeTruthy()

  const up = jsonOf<{ run_ids: string[] }>(await apiCall(page, apiBase, 'POST', '/self-declared-results', reviewBody(agentId!)), 'upload review fixture', [200, 201])
  const runId = up.run_ids[0]!
  expect(runId).toMatch(/^[0-9a-f-]{36}$/)

  // 1. Write one label and read it back.
  const w = jsonOf<{ id: string; labeler: string }>(
    await apiCall(page, apiBase, 'POST', '/grader-results/human', { run_id: runId, judge_id: JUDGE, pass: true, reason_code: 'other' }),
    'POST /grader-results/human',
    [201],
  )
  const back = jsonOf<{ labels: Array<{ id: string; judgeId: string; pass: boolean; reasonCode: string | null }> }>(
    await apiCall(page, apiBase, 'GET', `/grader-results/human?run_id=${runId}`),
    'GET /grader-results/human',
  )
  expect(back.labels.find((l) => l.id === w.id), 'the written label reads back').toMatchObject({ judgeId: JUDGE, pass: true, reasonCode: 'other' })
  // A free-text key is refused: the route stores no text.
  expect((await apiCall(page, apiBase, 'POST', '/grader-results/human', { run_id: runId, judge_id: JUDGE, pass: true, note: 'x' })).status).toBe(400)

  // 2. The screen at phone width, with a positive-data control.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/studio/review?judge=${JUDGE}`)
  await expectMounted(page)
  const card = page.getByTestId('review-card')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('review-position')).toHaveText(/^1 of \d+$/)
  await expect(card).toContainText('Waits use a watcher')
  await expect(page.getByTestId('review-pass')).toBeVisible()
  // The selected judge tab is readable: its text color differs from its background.
  const chip = await page.getByTestId(`review-judge-${JUDGE}`).evaluate((e) => { const c = getComputedStyle(e); return { fg: c.color, bg: c.backgroundColor } })
  expect(chip.fg, 'selected judge tab text differs from its background').not.toBe(chip.bg)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'no horizontal scroll at 390 px').toBeLessThanOrEqual(1)
})
