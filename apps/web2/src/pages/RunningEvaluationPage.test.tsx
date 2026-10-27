/**
 * L18 (plan 20261026-tma-local-runner-and-self-declared-results, task DFL-011CE): the page of a
 * self-declared evaluation shows its score, model, task and the "Self-declared" label, and a run
 * record that does not load gives an explicit error state, never an endless "Loading the run record…".
 * The fixture is the shape that prod answers for a self-declared evaluation (2026-10-27), with a fake owner.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionProvider } from '../auth/session'
import { saveSession } from '../auth/sessionStorage'
import { RunningEvaluationPage } from './RunningEvaluationPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OWNER = 'dfl:11111111-2222-4333-8444-555555555555'
const EID = '3a40b41c-9a51-821b-b39a-38dfcf4c7637'
const DETAIL = {
  id: EID,
  shortId: 'D3a40b41c9a51821bb39a38dfcf4c7637',
  slug: `sd-${EID}`,
  status: 'graded',
  uiState: 'graded',
  paymentKind: 'none',
  resultOrigin: 'self_declared',
  elapsedMs: 0,
  createdAt: '2026-10-27T02:04:47.345Z',
  agent: { id: '86c7fd83-9641-4d7f-ac56-c4a8a225d72f', name: 'tma-smoke-local', slug: 'tma-smoke-local', repo: null, commit: 'local-9be35f4', initials: 'TS', authorWallet: OWNER },
  model: { id: 'deepseek/deepseek-v4.1-flash', release: null },
  taskCount: 1,
  fee: { usdPerRun: 0, perTask: [{ taskId: '88831a87-9421-432f-8ebd-bf9ec1641683' }], usd: 0, lamports: 0, solUsdRate: 0, priceSource: null, txSig: null },
  stages: [
    { key: 'contract', state: 'done', detail: '1 task contract pinned' },
    { key: 'agent_calls', state: 'done', detail: '1 of 1 returned' },
    { key: 'grading', state: 'done', detail: '1 of 1 graded' },
  ],
  tasks: [
    { runId: EID, slotRunId: EID, seq: 1, attempts: 1, taskId: '88831a87-9421-432f-8ebd-bf9ec1641683', name: 'Duplicate settlement webhook', slug: 'tsk_webhook_dup', stage: 'graded', status: 'pass', phase: null, testsPassed: null, testsTotal: null, durationMs: 1000, outcome: 'PASS', score: 100 },
  ],
  events: [{ tMs: 0, tone: 'ok', label: 'Self-declared result imported', detail: "run on the owner's machine" }],
  proofs: [],
  score: 100,
  counts: { pass: 1, fail: 0, invalid: 0, review: 0, cancelled: 0, queued: 0, running: 0 },
  testsPassed: 0,
  testsTotal: 0,
  manifestSha256: '35d301945a6b',
  isPublic: false,
  freeRetriesUsed: 0,
  shareUrl: null,
}
const RUN = {
  runId: EID, status: 'pass', phase: null, scoreTotal: 100, benchmark: { id: 'tsk_webhook_dup', version: '1' },
  agentId: DETAIL.agent.id, agentVersionId: '9c6269bb-4895-419a-b353-1a8ad76317f8', createdAt: '2026-10-27T00:00:00.000Z', completedAt: '2026-10-27T00:00:01.000Z',
  modelCostUsd: 0, ownerWallet: OWNER, runStartSig: null, score: { parts: null }, tests: null, patchScope: null, patch: null, actionsCount: 0,
  modelTokens: { in: 0, out: 0 }, errors: [], proof: null, result: { state: 'completed', verdict: 'pass', scored: true }, evidence: null, resultOrigin: 'self_declared',
}

type RunAnswer = { status: number; body: unknown } | 'hang'
let runAnswers: RunAnswer[]
let runCalls: number
let root: Root | undefined
let container: HTMLDivElement
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const flush = (ms = 10) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)

beforeEach(() => {
  runAnswers = [{ status: 200, body: RUN }]
  runCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    if (path === `/evaluations/${EID}`) return json(DETAIL)
    if (path === `/runs/${EID}`) {
      const a = runAnswers[Math.min(runCalls++, runAnswers.length - 1)]!
      if (a === 'hang') return new Promise<Response>(() => undefined)
      return json(a.body, a.status)
    }
    if (path === `/runs/${EID}/actions`) return json({ runId: EID, afterSeq: 0, actions: [], hasMore: false, nextAfterSeq: 0 })
    if (path === '/public/tasks/tsk_webhook_dup') return json({ id: DETAIL.tasks[0]!.taskId, slug: 'tsk_webhook_dup', name: 'Duplicate settlement webhook', tags: [] })
    if (path === '/models') return json({ models: [{ id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' }] })
    if (path === '/tasks') return json({ tasks: [] })
    if (path === '/tags') return json({ tags: [] })
    if (path === '/me') return json({ wallet: OWNER, username: 'smoke', displayName: 'Smoke', bio: '', avatarUrl: null, initials: 'SM' })
    return json({ error: `unexpected endpoint ${path}` }, 404)
  }))
  saveSession({ token: 'l18-test-session', user: { id: OWNER, email: 'smoke@example.com' } })
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(props: { runTimeoutMs?: number } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[`/evaluations/${EID}`]}>
        <SessionProvider>
          <Routes>
            <Route path="/evaluations/:eid" element={<RunningEvaluationPage {...props} />} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    ),
  )
  await flush(30)
}

it('a self-declared evaluation renders its score, model, task, the self-declared label and the run sections', async () => {
  await mount()
  expect(q('review-score')?.textContent).toBe('100')
  expect(container.textContent).toContain('DeepSeek V4.1 Flash')
  expect(container.querySelector('[data-origin="self_declared"]')).not.toBeNull()
  expect(q('self-declared-note')).not.toBeNull()
  expect(q('artifacts-card')?.textContent).toContain('tsk_webhook_dup')
  expect(container.querySelectorAll('[data-testid="compare-row"]').length).toBeGreaterThanOrEqual(1)
  expect(q('artifacts-empty')?.textContent).toContain('Self-declared run')
  expect(container.textContent).not.toContain('Loading the run record')
})

it('a run record that answers 404 gives an explicit error state in both sections, not an endless spinner', async () => {
  runAnswers = [{ status: 404, body: { error: 'run not found' } }]
  await mount()
  await flush(50)
  expect(container.textContent).not.toContain('Loading the run record')
  expect(q('compare-error')?.textContent).toMatch(/not found/i)
  expect(q('artifacts-error')).not.toBeNull()
  // The rest of the page still shows the evaluation's own numbers.
  expect(q('review-score')?.textContent).toBe('100')
})

it('a failed run record can be retried, and the retry shows the data', async () => {
  runAnswers = [{ status: 503, body: { error: 'schema not ready' } }, { status: 200, body: RUN }]
  await mount()
  const retry = q('compare-error')?.querySelector('button')
  expect(retry).toBeTruthy()
  act(() => (retry as HTMLButtonElement).click())
  await flush(30)
  expect(q('compare-error')).toBeNull()
  expect(container.querySelectorAll('[data-testid="compare-row"]').length).toBeGreaterThanOrEqual(1)
})

it('a run record that never answers ends in an error state after the time limit', async () => {
  runAnswers = ['hang']
  await mount({ runTimeoutMs: 80 })
  expect(q('compare-loading')).not.toBeNull()
  await flush(150)
  expect(q('compare-loading')).toBeNull()
  expect(q('compare-error')?.textContent).toMatch(/did not answer/i)
})
