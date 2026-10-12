/**
 * Design fixtures — copied from the design mocks (Task Filter.dc.html, 02 Add Agent.dc.html).
 * Used only in fixture mode (VITE_FIXTURE_MODE=design): the design diff and development without the API.
 */
import type { Model, Tag, Task } from '../../lib/api/types'

export const TOOLS = ['Stripe API', 'Postgres', 'Prisma', 'GitHub CLI', 'GitHub Actions', 'OpenPencil', 'Tailwind', 'Vitest']
export const CONCEPTS = ['Idempotency', 'Concurrency', 'Money math']

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

export const TAGS: Tag[] = [...TOOLS.map((name) => ({ id: slug(name), name, kind: 'tool' as const })), ...CONCEPTS.map((name) => ({ id: slug(name), name, kind: 'concept' as const }))]
const tag = (name: string): Tag => TAGS.find((t) => t.name === name)!

const RAW: Array<{ id: string; name: string; tags: string[]; tests: number; min: number; desc: string; mine?: boolean }> = [
  { id: 'tsk_webhook_dup', name: 'Duplicate settlement webhook', tags: ['Stripe API', 'Idempotency'], tests: 14, min: 6, desc: 'Second delivery must not double-credit the ledger.' },
  { id: 'tsk_refund_race', name: 'Partial refund race condition', tags: ['Stripe API', 'Concurrency'], tests: 18, min: 9, desc: 'Concurrent refunds must never exceed the captured amount.' },
  { id: 'tsk_idem_keys', name: 'Idempotency keys on retry', tags: ['Stripe API', 'Idempotency'], tests: 11, min: 5, desc: 'Client retries return the original response.' },
  { id: 'tsk_pg_index', name: 'Missing index on hot query', tags: ['Postgres', 'Prisma'], tests: 8, min: 3, desc: 'Bring the p95 of the order lookup under budget.' },
  { id: 'tsk_gh_ci_fix', name: 'Fix failing CI and open a PR', tags: ['GitHub CLI', 'GitHub Actions'], tests: 12, min: 7, desc: 'Diagnose the red build, push a fix, open the PR with gh.' },
  { id: 'tsk_gh_release', name: 'Release notes from merged PRs', tags: ['GitHub CLI'], tests: 6, min: 3, desc: 'Draft notes from PRs merged since the last tag.' },
  { id: 'tsk_op_export', name: 'Export frames to SVG', tags: ['OpenPencil'], tests: 10, min: 5, desc: 'Batch-export named frames with stable IDs.' },
  { id: 'tsk_op_tokens', name: 'Sync design tokens to code', tags: ['OpenPencil', 'Tailwind'], tests: 9, min: 5, desc: 'Map OpenPencil styles to a Tailwind theme file.' },
  { id: 'tsk_flaky_state', name: 'Flaky test with shared state', tags: ['Vitest', 'Concurrency'], tests: 9, min: 4, desc: 'Fix the root cause, not the retry count.' },
  { id: 'my_ledger_reconcile', name: 'Ledger reconcile after outage', tags: ['Stripe API', 'Postgres'], tests: 16, min: 8, mine: true, desc: 'Replay missed events and reconcile balances.' },
  { id: 'my_brl_rounding', name: 'BRL payout rounding', tags: ['Stripe API', 'Money math'], tests: 7, min: 3, mine: true, desc: 'Round BRL payouts to centavos without drift.' },
]

/** Catalog in the API shape. `agentsRunCount` is filled from the agents fixture in handlers. */
export const TASKS: Task[] = RAW.map((t) => ({
  id: t.id,
  slug: t.id,
  name: t.name,
  description: t.desc,
  tags: t.tags.map(tag),
  kind: t.mine ? 'user' : 'itera',
  visibility: t.mine ? 'private' : 'public',
  status: 'ready',
  runnable: true,
  hiddenTestsCount: t.tests,
  estMinutes: t.min,
  mine: !!t.mine,
  agentsRunCount: 0,
}))

export const MODELS: Model[] = [
  { label: 'Claude Fable 5.1', provider: 'Anthropic', id: 'anthropic/claude-fable-5.1', rel: ['claude-fable-5.1-20260918', 'claude-fable-5.1-20260801'] },
  { label: 'GPT-5.6 Sol', provider: 'OpenAI', id: 'openai/gpt-5.6-sol', rel: ['gpt-5.6-sol-2026-09-30', 'gpt-5.6-sol-2026-08-12'] },
  { label: 'Gemini 3 Pro', provider: 'Google', id: 'google/gemini-3-pro', rel: ['gemini-3-pro-002', 'gemini-3-pro-001'] },
  { label: 'Grok 4.6', provider: 'xAI', id: 'x-ai/grok-4.6', rel: ['grok-4.6-0915'] },
  { label: 'DeepSeek V4', provider: 'DeepSeek', id: 'deepseek/deepseek-v4', rel: ['deepseek-v4-0901'] },
  { label: 'Qwen3 Coder', provider: 'Alibaba', id: 'qwen/qwen3-coder', rel: ['qwen3-coder-480b-0820'] },
].map((m) => ({ id: m.id, label: m.label, provider: m.provider, enabled: true, supportsTools: true, releases: m.rel.map((id, i) => ({ id, isLatest: i === 0 })) }))

/** Price of the fixture quote: US$0.10 per run at the plan's example rate. */
export const PRICE = { usdPerRun: 0.1, solUsdRate: 108.98, priceSource: 'pyth' as const }
export const lamportsFor = (runs: number) => Math.round(((runs * PRICE.usdPerRun) / PRICE.solUsdRate) * 1e9)
export const solFor = (runs: number) => (lamportsFor(runs) / 1e9).toFixed(5)
