/** Agents of 01 Agents.dc.html / 08 Agent Detail.dc.html, and the ranking rule of design brief 2.3. */
import type { Agent, RankingRow } from '../../lib/api/types'
import { initialsOf } from '../../tma/ui/Avatar'
import { MODELS, lamportsFor, PRICE, solFor, TASKS } from './catalog'

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
