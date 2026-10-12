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
  agentMyResults,
  DFL_ICON_URL,
  TASK_AUTHORS,
  agentProfile,
  agentRecord,
  evaluationDetail,
  EVALUATIONS,
  evaluationTotals,
  lamportsFor,
  MCP_CATALOG,
  MODELS,
  PRICE,
  PUBLIC_EVALUATION,
  RAW_AGENTS,
  ranking,
  RUN_COUNTS,
  solFor,
  TAGS,
  taskCompatibility,
  taskProfile,
  TASKS,
  MY_TASK_DRAFTS,
  fixtureTask,
  fixtureLayout,
  fixtureCreateTask,
  fixturePatchTask,
  fixtureDeleteTask,
  fixtureAddVersion,
  fixtureValidate,
} from './design'
import type { TaskSourceInput } from '../lib/api/types'

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
    if (p.get('include') === 'overview') {
      // Tasks page (U35): every visible task, drafts included, with author, agents count and best result.
      const everything = [...all, ...MY_TASK_DRAFTS]
      const overview = everything.map((t) => {
        const top = ranking({ taskIds: [t.id] }).find((r) => r.coverage?.k === 1 && r.score != null)
        const a = TASK_AUTHORS[t.id]
        const author = t.mine
          ? { wallet: FIXTURE_USER.wallet, name: FIXTURE_USER.displayName ?? 'you', handle: FIXTURE_USER.handle ?? null, avatarUrl: null, isDfl: false }
          : { wallet: null, name: a?.name ?? 'DevFellowship', handle: null, avatarUrl: a?.dfl === false || (a && !a.dfl) ? null : DFL_ICON_URL, isDfl: !!a?.dfl }
        return {
          ...t,
          author,
          agentsCount: RUN_COUNTS[t.id] ?? 0,
          bestResult: top ? { agent: { id: top.id, slug: top.slug, name: top.name, initials: top.initials, avatarUrl: null, author: { name: top.authorName, wallet: '', avatarUrl: null } }, score: top.score! } : null,
        }
      })
      const shown = overview
        .filter((t) => source === 'all' || (source === 'mine' ? t.mine : !t.mine))
        .filter((t) => !tag || t.tags.some((g) => g.id === tag))
        .filter((t) => !q || [t.name, t.slug, t.description, ...t.tags.map((g) => g.name)].join(' ').toLowerCase().includes(q))
      return HttpResponse.json({ tasks: shown, counts: { all: everything.length, public: everything.filter((t) => !t.mine).length, mine: everything.filter((t) => t.mine).length } })
    }
    // Drafts of My tasks (screen 10) only on source=mine, so the Task Filter of 01/03 keeps its mock's catalog.
    const tasks = [...all, ...(source === 'mine' ? MY_TASK_DRAFTS : [])]
      .filter((t) => source === 'all' || (source === 'mine' ? t.mine : !t.mine))
      .filter((t) => !tag || t.tags.some((g) => g.id === tag))
      .filter((t) => !q || [t.name, t.slug, t.description, ...t.tags.map((g) => g.name)].join(' ').toLowerCase().includes(q))
    return HttpResponse.json({ tasks, counts: { all: all.length, public: all.filter((t) => !t.mine).length, mine: all.filter((t) => t.mine).length } })
  }),
  http.get(u('/tags'), ({ request }) => {
    const kind = new URL(request.url).searchParams.get('kind') as TagKind | null
    return HttpResponse.json({ tags: TAGS.filter((t) => !kind || t.kind === kind).map((t) => ({ ...t, count: TASKS.filter((x) => x.tags.some((g) => g.id === t.id)).length })) })
  }),
  // U29 / U31: the Itera MCP catalog with the pinned tools snapshots.
  http.get(u('/mcp-catalog'), () => HttpResponse.json({ servers: MCP_CATALOG })),
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
  // U34: the design fixture repo holds one task at its root; the folder dropdown stays hidden (design 10 shows the plain path field).
  http.get(u('/github/repos/:owner/:repo/task-candidates'), ({ params }) =>
    HttpResponse.json({ repoFullName: `${String(params.owner)}/${String(params.repo)}`, commitSha: '9f2c1ab4e7d0c3b5a8f6e2d1c0b9a8f7e6d5c4b3', truncatedTree: false, capped: false, candidates: [] }),
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
    const p = agentProfile(String(params.id))
    return p ? HttpResponse.json(p) : notFound()
  }),
  http.get(u('/agents/:id/my-results'), ({ params }) => {
    const r = agentMyResults(String(params.id))
    return r ? HttpResponse.json(r) : notFound()
  }),
  // README badge (U16): the API renders it with badge-maker; here a hand-written SVG of the same look (rgb() on purpose: the token file is the only place for brand hex).
  http.get(u('/badge/agents/:file'), ({ params }) => {
    const p = agentProfile(String(params.file).replace(/\.svg$/, ''))
    const msg = p?.stats.score != null ? `${p.stats.score.toFixed(1)} · ${p.stats.tasksEvaluated} tasks` : 'not found'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="166" height="20" role="img" aria-label="testmyagent: ${msg}"><rect width="79" height="20" fill="rgb(28,25,22)"/><rect x="79" width="87" height="20" fill="rgb(28,58,42)"/><g font-family="Verdana,Geneva,sans-serif" font-size="11" text-anchor="middle"><text x="40" y="14" fill="rgb(244,237,226)">testmyagent</text><text x="122" y="14" fill="rgb(143,233,177)">${msg}</text></g></svg>`
    return new HttpResponse(svg, { headers: { 'Content-Type': 'image/svg+xml' } })
  }),
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
      // v2 itemization (U7 #54): the design charges a flat fee, so the fixture has no model forecast.
      modelCostEstimateUsd: 0,
      baseFeeUsd: Math.round(n * PRICE.usdPerRun * 100) / 100,
      totalUsd: Math.round(n * PRICE.usdPerRun * 100) / 100,
      totalLamports: lamportsFor(n),
      taskCount: n,
      tasks: (body.taskIds ?? []).map((taskId, i) => ({ taskId, slug: taskId, name: taskId, seq: i + 1, runId: `run_${i + 1}`, modelCostEstimateUsd: 0, baseFeeUsd: PRICE.usdPerRun, priceUsd: PRICE.usdPerRun, estimateBasis: 'list_price' })),
    })
  }),
  // U11: the one wallet prompt. Fixture mode has no wallet, so the build answers like a payer without funds.
  http.post(u('/evaluations/quote/:reference/transaction'), () => HttpResponse.json({ error: 'fixture mode: no wallet', code: 'insufficient_funds' }, { status: 402 })),
  http.post(u('/evaluations'), () => HttpResponse.json({ evaluationId: 'ev_queued', status: 'pending', runs: [] }, { status: 202 })),
  http.get(u('/evaluations'), ({ request }) => {
    const scope = new URL(request.url).searchParams.get('scope') ?? 'all'
    const list = EVALUATIONS.filter((e) => scope === 'all' || (scope === 'my_agents' || scope === 'mine-agents' ? e.agent.isMine : !e.agent.isMine))
    return HttpResponse.json({ evaluations: list, totals: evaluationTotals(EVALUATIONS) })
  }),
  http.get(u('/evaluations/:id'), ({ params }) => {
    const d = evaluationDetail(String(params.id))
    return d ? HttpResponse.json(d) : notFound()
  }),
  // U12: per-run detail for the model cost and the tool-call count.
  http.get(u('/runs/:id'), ({ params }) => {
    const i = Number(String(params.id).replace(/^run_/, ''))
    if (!i) return notFound()
    return HttpResponse.json({ runId: params.id, status: 'running', phase: 'agent_running', scoreTotal: null, modelCostUsd: null, actionsCount: 4 + i, proof: null })
  }),
  // U23: the agent's tool calls for the event log. The design mocks log no individual calls (their "Called agent"
  // lines are task-level events), so every design run answers an empty page and the 04 states stay pixel-true.
  // `run_calls` is a sample run with three calls, to exercise the after_seq cursor in fixture mode.
  http.get(u('/runs/:id/actions'), ({ params, request }) => {
    const afterSeq = Number(new URL(request.url).searchParams.get('after_seq') ?? 0) || 0
    const all =
      params.id === 'run_calls'
        ? [
            { seq: 1, tool: 'read', target: 'src/ledger.ts', ok: true, occurredAt: '2026-10-12T14:00:05.000Z' },
            { seq: 2, tool: 'edit', target: 'src/ledger.ts', ok: true, occurredAt: '2026-10-12T14:00:21.000Z' },
            { seq: 3, tool: 'bash', target: 'npm test', ok: false, occurredAt: '2026-10-12T14:00:40.000Z' },
          ]
        : []
    const actions = all.filter((a) => a.seq > afterSeq)
    return HttpResponse.json({ runId: params.id, afterSeq, actions, hasMore: false, nextAfterSeq: actions.length ? actions[actions.length - 1]!.seq : afterSeq })
  }),
  http.post(u('/evaluations/:id/cancel'), () => HttpResponse.json({ status: 'cancelled' })),

  // Public surface
  http.get(u('/public/evaluations/:slug'), ({ params }) =>
    params.slug === PUBLIC_EVALUATION.slug || params.slug === PUBLIC_EVALUATION.hash ? HttpResponse.json(PUBLIC_EVALUATION) : HttpResponse.json({ error: 'not found' }, { status: 404 }),
  ),

  // My tasks (U19 contract, U20 screens). Fixture user tasks first; anything else is the catalog view.
  http.post(u('/tasks/layout'), async ({ request }) => {
    const r = fixtureLayout((await request.json()) as TaskSourceInput)
    return 'status' in r ? HttpResponse.json({ error: r.error }, { status: r.status }) : HttpResponse.json(r)
  }),
  http.post(u('/tasks'), async ({ request }) => {
    const r = fixtureCreateTask((await request.json()) as TaskSourceInput)
    return 'status' in r ? HttpResponse.json({ error: r.error }, { status: r.status }) : HttpResponse.json(r, { status: 201 })
  }),
  // Public task profile (U30) and the compatibility check (U28). More specific than /tasks/:id below.
  http.get(u('/public/tasks/:slug'), ({ params, request }) => {
    const v = Number(new URL(request.url).searchParams.get('v') ?? 0) || undefined
    const p = taskProfile(String(params.slug), v)
    return p ? HttpResponse.json(p) : notFound()
  }),
  http.get(u('/tasks/:id/compatibility'), ({ params, request }) => {
    const c = taskCompatibility(String(params.id), new URL(request.url).searchParams.get('agentId') ?? '')
    return c ? HttpResponse.json(c) : notFound()
  }),

  http.get(u('/tasks/:id'), ({ params }) => {
    const mine = fixtureTask(String(params.id))
    if (mine) return HttpResponse.json({ task: mine })
    const t = tasksWithCounts().find((x) => x.id === params.id)
    return t ? HttpResponse.json(t) : notFound()
  }),
  http.patch(u('/tasks/:id'), async ({ params, request }) => {
    const t = fixturePatchTask(String(params.id), (await request.json()) as { name?: string; description?: string; tags?: string[] })
    return t ? HttpResponse.json({ task: t }) : notFound()
  }),
  http.delete(u('/tasks/:id'), ({ params }) => (fixtureDeleteTask(String(params.id)) ? HttpResponse.json({ id: params.id, deleted: true }) : notFound())),
  http.post(u('/tasks/:id/versions'), async ({ params, request }) => {
    const r = fixtureAddVersion(String(params.id), (await request.json()) as Partial<TaskSourceInput>)
    if (!r) return notFound()
    if ('status' in r) return HttpResponse.json({ error: r.error }, { status: r.status })
    return HttpResponse.json(r, { status: 'unchanged' in r ? 200 : 201 })
  }),
  http.post(u('/tasks/:id/versions/:v/validate'), ({ params }) => {
    const r = fixtureValidate(String(params.id), Number(params.v))
    return r ? HttpResponse.json(r, { status: 202 }) : notFound()
  }),
  http.get(u('/tasks/:id/versions/:v/validation'), ({ params }) => {
    const t = fixtureTask(String(params.id))
    const v = t?.versions.find((x) => x.version === Number(params.v))
    if (!t || !v || !t.validation || t.validation.taskVersionId !== v.id) return HttpResponse.json({ error: 'no validation for this version yet' }, { status: 404 })
    return HttpResponse.json({ validation: t.validation, version: v, taskStatus: t.status })
  }),
]
