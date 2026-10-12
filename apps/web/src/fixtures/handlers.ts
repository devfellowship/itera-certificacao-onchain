/**
 * MSW handlers of fixture mode: the API contract of the plan, answered from the design mocks.
 * A lane that adds an endpoint adds its fixture handler here in the same PR.
 */
import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '../lib/api/client'
import type { TagKind } from '../lib/api/types'
import { FIXTURE_USER } from '../auth/fixture'
import {
  agentId,
  agentRecord,
  agentResults,
  evaluationDetail,
  EVALUATIONS,
  evaluationTotals,
  lamportsFor,
  MODELS,
  PRICE,
  PUBLIC_EVALUATION,
  RAW_AGENTS,
  ranking,
  RUN_COUNTS,
  solFor,
  TAGS,
  TASKS,
} from './design'

const u = (path: string) => `${API_BASE_URL}${path}`
const notFound = () => HttpResponse.json({ error: 'not found' }, { status: 404 })

function tasksWithCounts() {
  return TASKS.map((t) => ({ ...t, agentsRunCount: RUN_COUNTS[t.id] ?? 0 }))
}

export const handlers = [
  // Identity
  http.get(u('/auth/me'), () => HttpResponse.json({ wallet: FIXTURE_USER.wallet })),
  http.get(u('/me'), () => HttpResponse.json({ wallet: FIXTURE_USER.wallet, displayName: FIXTURE_USER.displayName, handle: FIXTURE_USER.handle, initials: FIXTURE_USER.initials })),

  // Catalog
  http.get(u('/tasks'), ({ request }) => {
    const p = new URL(request.url).searchParams
    const source = p.get('source') ?? 'all'
    const q = (p.get('q') ?? '').toLowerCase()
    const tag = p.get('tag')
    const all = tasksWithCounts()
    const tasks = all
      .filter((t) => source === 'all' || (source === 'mine' ? t.mine : !t.mine))
      .filter((t) => !tag || t.tags.some((g) => g.id === tag))
      .filter((t) => !q || [t.name, t.slug, t.description, ...t.tags.map((g) => g.name)].join(' ').toLowerCase().includes(q))
    return HttpResponse.json({ tasks, counts: { all: all.length, public: all.filter((t) => !t.mine).length, mine: all.filter((t) => t.mine).length } })
  }),
  http.get(u('/tags'), ({ request }) => {
    const kind = new URL(request.url).searchParams.get('kind') as TagKind | null
    return HttpResponse.json({ tags: TAGS.filter((t) => !kind || t.kind === kind).map((t) => ({ ...t, count: TASKS.filter((x) => x.tags.some((g) => g.id === t.id)).length })) })
  }),
  http.get(u('/models'), () => HttpResponse.json({ models: MODELS })),

  // GitHub
  http.get(u('/github/install-url'), () => HttpResponse.json({ url: 'https://github.com/apps/testmyagent-watcher/installations/new', state: 'fixture' })),
  http.get(u('/github/installations'), () => HttpResponse.json({ installations: [{ installationId: 1, accountLogin: 'settlewise-labs' }] })),
  http.get(u('/github/repos'), () => HttpResponse.json({ repos: [{ fullName: 'settlewise-labs/settlewise-agent', installationId: 1, accountLogin: 'settlewise-labs', private: true, defaultBranch: 'main' }] })),
  http.get(u('/github/callback'), () => HttpResponse.json({ installationId: 1, accountLogin: 'settlewise-labs', ownerWallet: FIXTURE_USER.wallet })),
  http.get(u('/github/repos/:owner/:repo/branches'), () =>
    HttpResponse.json({
      defaultBranch: 'main',
      branches: [
        { name: 'main', headSha: '9f2c1ab4e7d0c3b5a8f6e2d1c0b9a8f7e6d5c4b3', shortSha: '9f2c1ab', isDefault: true },
        { name: 'release/1.2', headSha: '3e07a21c5b90c4d209fa7f3a2be19c04d6e81a5f', shortSha: '3e07a21', isDefault: false },
      ],
    }),
  ),
  http.get(u('/github/repos/:owner/:repo/commits'), () =>
    HttpResponse.json({
      branch: 'main',
      headSha: '9f2c1ab4e7d0c3b5a8f6e2d1c0b9a8f7e6d5c4b3',
      commits: [
        { sha: '9f2c1ab4e7d0c3b5a8f6e2d1c0b9a8f7e6d5c4b3', shortSha: '9f2c1ab', message: 'Handle duplicate settlement webhooks', date: '2026-10-12T09:14:00Z', authorName: 'Bruno Lima', isHead: true },
        { sha: '4be192af7f3ac91e5a7b2c3d4e5f60718293a4b5', shortSha: '4be192a', message: 'Add refund race test', date: '2026-10-11T18:02:00Z', authorName: 'Bruno Lima', isHead: false },
        { sha: 'a91c04dee27b5f10c41e7d2c4d209fa3e07a21c5', shortSha: 'a91c04d', message: 'Bump vitest', date: '2026-10-10T12:40:00Z', authorName: 'Bruno Lima', isHead: false },
      ],
    }),
  ),
  http.post(u('/agents/validate'), () =>
    HttpResponse.json({
      ok: true,
      files: [
        { path: 'AGENTS.md', bytes: 6120 },
        { path: 'skills/webhooks/SKILL.md', bytes: 11840 },
        { path: 'skills/refunds/SKILL.md', bytes: 12210 },
        { path: 'skills/postgres/SKILL.md', bytes: 11800 },
      ],
      summary: 'AGENTS.md + 3 skills · 41 KB',
      skillCount: 3,
      totalBytes: 41970,
      commit: '9f2c1ab4e7d0c3b5a8f6e2d1c0b9a8f7e6d5c4b3',
      shortCommit: '9f2c1ab',
      branch: 'main',
    }),
  ),

  // Agents
  http.get(u('/agents/ranking'), ({ request }) => {
    const p = new URL(request.url).searchParams
    const taskIds = (p.get('taskIds') ?? '').split(',').filter(Boolean)
    return HttpResponse.json({ rows: ranking({ scope: (p.get('scope') as 'all' | 'mine') ?? 'all', q: p.get('q') ?? '', taskIds }), price: PRICE })
  }),
  http.get(u('/agents'), () => HttpResponse.json({ agents: RAW_AGENTS.filter((a) => a.by === 'Bruno Lima').map(agentRecord) })),
  http.post(u('/agents'), () => HttpResponse.json({ agent: agentRecord(RAW_AGENTS.find((a) => a.name === 'Settlewise')!) }, { status: 201 })),
  http.get(u('/agents/:id/profile'), ({ params }) => {
    const a = RAW_AGENTS.find((x) => agentId(x.name) === params.id)
    if (!a) return notFound()
    return HttpResponse.json({ agent: agentRecord(a), score: a.score, results: agentResults(agentId(a.name)) })
  }),
  http.get(u('/agents/:id/my-results'), () => HttpResponse.json({ results: [] })),
  http.get(u('/agents/:id'), ({ params }) => {
    const a = RAW_AGENTS.find((x) => agentId(x.name) === params.id)
    return a ? HttpResponse.json({ agent: agentRecord(a) }) : notFound()
  }),

  // Evaluations
  http.post(u('/evaluations/quote'), async ({ request }) => {
    const body = (await request.json()) as { taskIds?: string[] }
    const n = body.taskIds?.length ?? 0
    return HttpResponse.json({
      priceUsdPerRun: PRICE.usdPerRun,
      amountUsd: Math.round(n * PRICE.usdPerRun * 100) / 100,
      solUsdRate: PRICE.solUsdRate,
      priceSource: PRICE.priceSource,
      amountLamports: lamportsFor(n),
      sol: solFor(n),
      treasury: 'TMAtreasuryFixture1111111111111111111111111',
      reference: 'RefFixture11111111111111111111111111111111',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    })
  }),
  http.post(u('/evaluations'), () => HttpResponse.json({ evaluationId: 'ev_queued', status: 'pending', runs: [] }, { status: 202 })),
  http.get(u('/evaluations'), ({ request }) => {
    const scope = new URL(request.url).searchParams.get('scope') ?? 'all'
    const list = EVALUATIONS.filter((e) => scope === 'all' || (scope === 'mine-agents' ? e.agent.isMine : !e.agent.isMine))
    return HttpResponse.json({ evaluations: list, totals: evaluationTotals(EVALUATIONS) })
  }),
  http.get(u('/evaluations/:id'), ({ params }) => {
    const d = evaluationDetail(String(params.id))
    return d ? HttpResponse.json(d) : notFound()
  }),
  http.post(u('/evaluations/:id/cancel'), () => HttpResponse.json({ status: 'cancelled' })),

  // Public surface
  http.get(u('/public/evaluations/:slug'), ({ params }) =>
    params.slug === PUBLIC_EVALUATION.slug || params.slug === PUBLIC_EVALUATION.hash ? HttpResponse.json(PUBLIC_EVALUATION) : HttpResponse.json({ error: 'not found' }, { status: 404 }),
  ),

  // My tasks
  http.get(u('/tasks/:id'), ({ params }) => {
    const t = tasksWithCounts().find((x) => x.id === params.id)
    return t ? HttpResponse.json({ ...t, versions: [], bestResult: null }) : notFound()
  }),
]
