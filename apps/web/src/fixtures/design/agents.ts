/** Agents of 01 Agents.dc.html / 08 Agent Detail.dc.html, and the ranking rule of design brief 2.3. */
import type { Agent, AgentMyResultsResponse, AgentProfile, AgentProfileResponse, RankingRow } from '../../lib/api/types'
import { initialsOf } from '../../tma/ui/Avatar'
import { MODELS, lamportsFor, PRICE, solFor, TAGS, TASKS } from './catalog'

export const ME = 'Bruno Lima'

interface RawAgent {
  name: string
  by: string
  when: string
  model: string
  score: number | null
  desc: string
  r: Record<string, number>
  draft?: boolean
}

export const RAW_AGENTS: RawAgent[] = [
  { name: 'Ledgerline', by: 'Mara Okafor', when: '2 days ago', model: 'Claude Fable 5.1', score: 91.2, desc: 'Fixes idempotency and replay bugs in payment webhooks.', r: { tsk_webhook_dup: 100, tsk_refund_race: 83.3, tsk_idem_keys: 100, tsk_pg_index: 100, tsk_flaky_state: 88.9, tsk_gh_ci_fix: 100, my_ledger_reconcile: 81.3, my_brl_rounding: 100 } },
  { name: 'Patchwright', by: 'Diego Santos', when: '5 days ago', model: 'Claude Fable 5.1', score: 88.7, desc: 'Upgrades deprecated APIs across large TypeScript monorepos.', r: { tsk_gh_ci_fix: 100, tsk_gh_release: 100, tsk_flaky_state: 77.8, tsk_pg_index: 75 } },
  { name: 'Schemasmith', by: 'Ana Ferreira', when: '1 week ago', model: 'Gemini 3 Pro', score: 87.9, desc: 'Writes reversible Postgres migrations with zero-downtime backfills.', r: { tsk_pg_index: 100, tsk_refund_race: 72.2, tsk_webhook_dup: 92.9, my_ledger_reconcile: 62.5 } },
  { name: 'Pencilwright', by: 'Lea Hoffmann', when: '4 days ago', model: 'Qwen3 Coder', score: 86.4, desc: 'Turns OpenPencil files into exports, tokens and component stubs.', r: { tsk_op_export: 100, tsk_op_tokens: 77.8 } },
  { name: 'Flakehound', by: 'Kenji Mori', when: '1 week ago', model: 'Grok 4.6', score: 84.3, desc: 'Finds and stabilizes flaky tests in CI pipelines without muting them.', r: { tsk_flaky_state: 100, tsk_gh_ci_fix: 83.3, tsk_gh_release: 66.7 } },
  { name: 'Gatekeeper', by: 'Priya Raman', when: '3 weeks ago', model: 'GPT-5.6 Sol', score: 82.6, desc: 'Hardens auth flows: session expiry, token rotation and CSRF checks.', r: { tsk_gh_ci_fix: 75, tsk_webhook_dup: 85.7, tsk_idem_keys: 90.9 } },
  { name: 'Settlewise', by: ME, when: 'today', model: 'Claude Fable 5.1', score: 78.6, desc: 'Fixes settlement, refund and webhook bugs in payment services.', r: { tsk_webhook_dup: 100, tsk_refund_race: 66.7, tsk_idem_keys: 100, tsk_pg_index: 100, my_ledger_reconcile: 75 } },
  { name: 'Rustbelt', by: 'Tomás Rey', when: '1 month ago', model: 'DeepSeek V4', score: 76.1, desc: 'Ports hot Python paths to Rust extensions with parity tests.', r: { tsk_pg_index: 62.5, tsk_flaky_state: 88.9 } },
  { name: 'Querytune', by: ME, when: '3 days ago', model: 'GPT-5.6 Sol', score: 74.8, desc: 'Rewrites slow ORM queries and adds the missing indexes.', r: { tsk_pg_index: 87.5, my_ledger_reconcile: 62.5, my_brl_rounding: 71.4 } },
  { name: 'Tokenward', by: 'Sam Adeyemi', when: '2 weeks ago', model: 'GPT-5.6 Sol', score: 69.4, desc: 'Rotates and scopes API tokens across services safely.', r: { tsk_idem_keys: 72.7, tsk_gh_ci_fix: 66.7 } },
  { name: 'Logweaver', by: ME, when: '2 weeks ago', model: 'Qwen3 Coder', score: null, draft: true, desc: 'Adds structured logging and trace IDs to Node services.', r: {} },
]

/** Fixture agent id = lowercase name ("settlewise"). */
export const agentId = (name: string) => name.toLowerCase()

/** Task id → number of agents with a result (Task Filter `counts`). */
export const RUN_COUNTS: Record<string, number> = RAW_AGENTS.reduce<Record<string, number>>((m, a) => {
  for (const k of Object.keys(a.r)) m[k] = (m[k] ?? 0) + 1
  return m
}, {})

export function agentRecord(a: RawAgent): Agent {
  const model = MODELS.find((m) => m.label === a.model)
  return {
    id: agentId(a.name),
    slug: agentId(a.name),
    name: a.name,
    description: a.desc,
    repoFullName: `${a.by === ME ? 'brunolima' : a.by.split(' ')[0].toLowerCase()}/${agentId(a.name)}`,
    agentPath: '.',
    branch: 'main',
    pinnedCommit: a.name === 'Ledgerline' ? 'c41e7d2' : '9f2c1ab',
    model: model?.id ?? null,
    modelRelease: model?.releases[0]?.id ?? null,
    visibility: 'listed',
    status: a.draft ? 'draft' : 'active',
    authorName: a.by,
    isMine: a.by === ME,
  }
}

/** Ranking of design brief 2.3: with tasks, sort by coverage then score over the covered tasks. */
export function ranking({ scope = 'all', q = '', taskIds = [] as string[] }): RankingRow[] {
  const n = taskIds.length
  const needle = q.trim().toLowerCase()
  return RAW_AGENTS.filter((a) => scope !== 'mine' || a.by === ME)
    .filter((a) => !needle || [a.name, a.by, a.desc, a.model].join(' ').toLowerCase().includes(needle))
    .map((a) => {
      const cov = taskIds.filter((i) => a.r[i] != null)
      const k = cov.length
      const score = n ? (k ? cov.reduce((s, i) => s + a.r[i], 0) / k : null) : a.score
      return { a, k, score }
    })
    .sort((x, y) => (n ? y.k - x.k : 0) || (y.score ?? -1) - (x.score ?? -1))
    .map(({ a, k, score }) => ({
      id: agentId(a.name),
      slug: agentId(a.name),
      name: a.name,
      initials: initialsOf(a.name.slice(0, 2)),
      authorName: a.by,
      isMine: a.by === ME,
      when: a.when,
      description: a.desc,
      modelLabel: a.model,
      draft: !!a.draft,
      score: score == null ? null : Math.round(score * 10) / 10,
      taskCount: Object.keys(a.r).length,
      coverage: { k, n, perTask: taskIds.map((i) => a.r[i] != null) },
      runCostUsd: Math.round((n - k) * PRICE.usdPerRun * 100) / 100,
      runCostLamports: lamportsFor(n - k),
      runCostSol: solFor(n - k),
    }))
}

/** Per-task results of an agent (08 "Public evidence"). */
export function agentResults(name: string) {
  const a = RAW_AGENTS.find((x) => agentId(x.name) === name)
  if (!a) return null
  return Object.entries(a.r).map(([taskId, score]) => ({ task: TASKS.find((t) => t.id === taskId)!, score, outcome: score === 100 ? 'PASS' : 'FAIL' }))
}

/** Hidden-suite size per public task; Ledgerline's rows of 08 (14/14, 11/11, 12/12, 15/18, 8/8, 8/9) come out of it. */
const TESTS_TOTAL: Record<string, number> = { tsk_webhook_dup: 14, tsk_idem_keys: 11, tsk_gh_ci_fix: 12, tsk_refund_race: 18, tsk_pg_index: 8, tsk_flaky_state: 9, tsk_gh_release: 6, tsk_op_export: 10, tsk_op_tokens: 9 }
/** Evidence order, date and attestation of Ledgerline in 08 Agent Detail. */
const LEDGERLINE_EVIDENCE: Array<[string, string, string]> = [
  ['tsk_webhook_dup', '2026-10-10T14:38:00Z', '4Kx9'],
  ['tsk_idem_keys', '2026-10-10T14:38:00Z', '4Kx9'],
  ['tsk_gh_ci_fix', '2026-10-10T14:38:00Z', '4Kx9'],
  ['tsk_refund_race', '2026-09-28T09:12:00Z', '8Ld2'],
  ['tsk_pg_index', '2026-09-28T09:12:00Z', '8Ld2'],
  ['tsk_flaky_state', '2026-09-14T17:45:00Z', 'Fq7s'],
]
/** The mock of 08 lists fewer tags per row than the Task Filter catalog (no Prisma, no GitHub Actions). */
const EVIDENCE_TAGS: Record<string, string[]> = { tsk_pg_index: ['Postgres'], tsk_gh_ci_fix: ['GitHub CLI'] }
const SIG_TAIL: Record<string, string> = { '4Kx9': 'aP2e', '8Ld2': 'mW4c', Fq7s: '1yNe' }
const fullSig = (head: string) => `${head}${'x'.repeat(80)}${SIG_TAIL[head] ?? 'zzzz'}`

/** GET /agents/:id/profile in fixture mode (design brief 2.8). Ledgerline reproduces the mock row by row. */
export function agentProfile(id: string): AgentProfileResponse | null {
  const a = RAW_AGENTS.find((x) => agentId(x.name) === id)
  if (!a) return null
  const entries = Object.keys(a.r).filter((k) => !k.startsWith('my_'))
  const ordered = a.name === 'Ledgerline' ? LEDGERLINE_EVIDENCE : entries.map((k, i): [string, string, string] => [k, `2026-10-${String(9 - (i % 8)).padStart(2, '0')}T12:00:00Z`, '4Kx9'])
  const evidence = ordered.map(([taskId, at, head]) => {
    const task = TASKS.find((t) => t.id === taskId)!
    const score = a.r[taskId]
    const total = TESTS_TOTAL[taskId] ?? 10
    const sig = fullSig(head)
    const rowTags = task.tags.filter((t) => !EVIDENCE_TAGS[taskId] || EVIDENCE_TAGS[taskId].includes(t.name))
    return {
      taskId,
      taskSlug: taskId,
      name: task.name,
      tags: rowTags.map((t) => ({ id: t.id, name: t.name })),
      outcome: (score === 100 ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
      score,
      testsPassed: Math.round((score / 100) * total),
      testsTotal: total,
      at,
      attestation: { status: 'confirmed', txSig: sig, short: `${sig.slice(0, 4)}…${sig.slice(-4)}`, explorerUrl: `https://solscan.io/tx/${sig}?cluster=devnet` },
      evaluation: { slug: `${id}-${head.toLowerCase()}`, shortId: head.toLowerCase() },
    }
  })
  const counts = new Map<string, { id: string; name: string; kind: 'tool' | 'concept'; count: number }>()
  for (const e of evidence) {
    for (const t of e.tags.map((g) => TAGS.find((x) => x.id === g.id)!)) {
      const cur = counts.get(t.id) ?? { id: t.id, name: t.name, kind: t.kind, count: 0 }
      cur.count += 1
      counts.set(t.id, cur)
    }
  }
  const tags = [...counts.values()].sort((x, y) => y.count - x.count || ordered.findIndex(([k]) => TASKS.find((t) => t.id === k)!.tags.some((g) => g.id === x.id)) - ordered.findIndex(([k]) => TASKS.find((t) => t.id === k)!.tags.some((g) => g.id === y.id)))
  const first = evidence[0]
  const model = MODELS.find((m) => m.label === a.model)
  const record = agentRecord(a)
  const profile: AgentProfile = {
    agent: {
      id,
      slug: id,
      name: a.name,
      initials: initialsOf(a.name.slice(0, 2)),
      description: a.desc,
      authorName: a.by,
      authorWallet: `${id}Wallet`,
      isMine: a.by === ME,
      listedAt: '2026-10-10T09:00:00Z',
      visibility: 'listed',
      draft: !!a.draft,
    },
    source: { repoFullName: record.repoFullName ?? null, branch: 'main', agentPath: '.', commit: record.pinnedCommit ?? null, commitShort: record.pinnedCommit ?? null },
    model: { id: model?.id ?? '', label: a.model, release: model?.releases[0]?.id ?? null },
    // "2d ago" in the mock: the date is relative to now so the render stays at 2d.
    stats: { score: a.score, tasksEvaluated: evidence.length, evaluations: a.name === 'Ledgerline' ? 3 : Math.min(evidence.length, 1), lastVerifiedAt: evidence.length ? new Date(Date.now() - 2 * 86_400_000 - 3_600_000).toISOString() : null },
    tags,
    evidence,
    latestAttestation: first?.attestation?.txSig
      ? { network: 'Solana devnet', status: 'confirmed', issuedAt: first.at, txSig: first.attestation.txSig, txShort: first.attestation.short ?? '', explorerUrl: first.attestation.explorerUrl ?? '', evaluationSlug: first.evaluation?.slug ?? null }
      : null,
    evaluations: evidence.length
      ? [{ id: `ev_${id}`, shortId: first.evaluation?.shortId ?? null, slug: first.evaluation?.slug ?? null, score: a.score, issuedAt: first.at, taskCount: evidence.length, counts: { pass: evidence.filter((e) => e.outcome === 'PASS').length, fail: evidence.filter((e) => e.outcome === 'FAIL').length, invalid: 0 }, profilePath: first.evaluation ? `/e/${first.evaluation.slug}` : null }]
      : [],
    badge: evidence.length ? { path: `/badge/agents/${id}.svg`, markdownLinkPath: first.evaluation ? `/e/${first.evaluation.slug}` : null } : null,
  }
  return { ...profile, price: { usdPerRun: PRICE.usdPerRun, solUsdRate: PRICE.solUsdRate, priceSource: PRICE.priceSource, runCostLamports: lamportsFor(1), runCostSol: solFor(1), indicative: true } }
}

/** GET /agents/:id/my-results in fixture mode: the agent's scores on the viewer's tasks (`my_*`) and the viewer's best own agent. */
export function agentMyResults(id: string): AgentMyResultsResponse | null {
  const a = RAW_AGENTS.find((x) => agentId(x.name) === id)
  if (!a) return null
  const mine = RAW_AGENTS.filter((x) => x.by === ME)
  const results = Object.keys(a.r)
    .filter((k) => k.startsWith('my_'))
    .map((k) => {
      const task = TASKS.find((t) => t.id === k)!
      const best = mine.filter((x) => x.r[k] != null).sort((x, y) => y.r[k] - x.r[k])[0]
      return {
        task: { id: task.id, name: task.name },
        outcome: (a.r[k] === 100 ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
        score: a.r[k],
        bestOwnAgent: best ? { id: agentId(best.name), name: best.name, score: best.r[k] } : null,
      }
    })
  return { results }
}
