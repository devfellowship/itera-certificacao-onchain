// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider } from './auth/session'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { AgentsPage } from './pages/AgentsPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
beforeEach(() => {
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function waitFor(check: () => boolean, label: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const row = (id: string, name: string, score: number | null) => ({
  rank: null,
  id,
  slug: null,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  authorName: 'Ana',
  isMine: false,
  when: '2026-10-14T10:00:00.000Z',
  description: null,
  modelLabel: 'Some model',
  draft: false,
  score,
  taskCount: 3,
  coverage: null,
  runCostUsd: 0.1,
  runCostLamports: 1000,
  runCostSol: '0.00092',
})

const profile = {
  agent: { id: 'agent-1', slug: null, name: 'Profile Agent', initials: 'PA', description: 'An agent.', authorName: 'Ana', authorWallet: 'dfl:1', isMine: false, listedAt: '2026-10-14T10:00:00.000Z', visibility: 'public', draft: false },
  source: { repoFullName: 'ana/agent', branch: 'main', agentPath: 'agent', commit: 'abc1234abc', commitShort: 'abc1234' },
  model: { id: 'm', label: 'Some model', release: null },
  stats: { score: 80, tasksEvaluated: 1, evaluations: 1, lastVerifiedAt: '2026-10-14T10:00:00.000Z' },
  tags: [],
  evidence: [
    {
      taskId: 't1',
      taskSlug: 'task-one',
      name: 'Task one',
      tags: [],
      outcome: 'PASS',
      score: 80,
      testsPassed: 4,
      testsTotal: 5,
      at: '2026-10-14T10:00:00.000Z',
      attestation: { status: 'confirmed', txSig: 'abc', short: 'abc…xyz', explorerUrl: 'https://solscan.io/tx/abc' },
      evaluation: { slug: 'eval-1', shortId: 'eval1' },
    },
  ],
  latestAttestation: { network: 'devnet', status: 'confirmed', issuedAt: '2026-10-14T10:00:00.000Z', txSig: 'abc', txShort: 'abc…xyz', explorerUrl: 'https://solscan.io/tx/abc', evaluationSlug: 'eval-1' },
  evaluations: [],
  price: { usdPerRun: 0.1, solUsdRate: 150, priceSource: 'x', runCostLamports: 1000, runCostSol: '0.00092', indicative: true },
}

function mountAt(path: string, handler: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => handler(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)),
  )
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<SessionProvider><Outlet /></SessionProvider>}>
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:aid" element={<AgentDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  )
  return c
}

describe('agents pages (web2 copy, no web3 parts)', () => {
  it('AgentsPage renders a row per ranked agent and no SOL text', async () => {
    const c = mountAt('/agents', (url) => {
      if (url.includes('/agents/ranking')) {
        return json(200, { rows: [row('a1', 'Alpha Agent', 90), row('a2', 'Beta Agent', null)], counts: { all: 2, mine: 0 }, price: { usdPerRun: 0.1, solUsdRate: null, priceSource: null } })
      }
      return json(200, { tasks: [], tags: [] })
    })
    await waitFor(() => c.textContent!.includes('Alpha Agent') && c.textContent!.includes('Beta Agent'), 'ranking rows')
    expect(c.textContent).not.toMatch(/\bSOL\b/)
    expect(c.textContent).not.toMatch(/lamport/i)
  })

  it('AgentDetailPage renders no Attestation and no solscan link', async () => {
    const c = mountAt('/agents/agent-1', () => json(200, profile))
    await waitFor(() => c.textContent!.includes('Profile Agent'), 'profile')
    expect(c.textContent).not.toMatch(/attestation/i)
    expect(c.innerHTML).not.toMatch(/solscan/i)
    expect(c.textContent).not.toMatch(/\bSOL\b/)
    expect(c.textContent).toContain('Free. Bring your own OpenRouter key.')
    expect(c.querySelector('[data-testid="open-evaluation-profile"]')).not.toBeNull()
  })
})
