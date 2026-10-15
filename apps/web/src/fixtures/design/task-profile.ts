/**
 * Fixture of the public task profile (/tasks/:slug, U30). The design has no mock of this page (it is new in
 * the U32 addendum), so these are sample values of the API shape: the task of the design catalog with one
 * pinned MCP server, to exercise every section. Fixture mode only.
 */
import type { TaskCompatibility, TaskProfile, TaskResults } from '../../lib/api/types'
import { TASKS } from './catalog'

const TOOLS = [
  { name: 'create_customer', description: 'Create a customer in the sandbox.', params: ['email', 'name'], required: ['email'], inputSchema: { type: 'object', properties: { email: { type: 'string' }, name: { type: 'string' } }, required: ['email'] } },
  { name: 'list_charges', description: 'List the charges of a customer.', params: ['customer_id'], required: [], inputSchema: { type: 'object', properties: { customer_id: { type: 'string' } } } },
]
const sha = (c: string) => c.repeat(64)

const EMPTY: TaskResults = { agentsEvaluated: 0, runs: 0, passRate: null, medianScore: null, medianDurationMs: null, outcomes: { pass: 0, fail: 0, invalid: 0 }, leaderboard: [] }
const RESULTS: TaskResults = {
  agentsEvaluated: 3,
  runs: 4,
  passRate: 0.75,
  medianScore: 91.5,
  medianDurationMs: 312000,
  outcomes: { pass: 3, fail: 1, invalid: 0 },
  leaderboard: [
    { rank: 1, agentName: 'Settlewise', agentSlug: 'settlewise', modelLabel: 'Claude Fable 5.1', score: 100, outcome: 'PASS', date: '2026-10-12T11:00:00.000Z', evaluationSlug: 'settlewise-a1b2' },
    { rank: 2, agentName: 'Ledgerhand', agentSlug: 'ledgerhand', modelLabel: 'GPT-5.6 Sol', score: 88, outcome: 'PASS', date: '2026-10-12T09:30:00.000Z', evaluationSlug: 'ledgerhand-c3d4' },
    { rank: 3, agentName: 'Patchwork', agentSlug: 'patchwork', modelLabel: 'Gemini 3 Pro', score: 55, outcome: 'FAIL', date: '2026-10-11T18:00:00.000Z', evaluationSlug: 'patchwork-e5f6' },
  ],
}

export function taskProfile(slug: string, version?: number): TaskProfile | null {
  const t = TASKS.find((x) => x.slug === slug && !x.mine)
  if (!t) return null
  const latest = 3
  const v = version && version >= 1 && version <= latest ? version : latest
  const runnable = slug === 'tsk_webhook_dup'
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    tags: t.tags,
    curatedByItera: true,
    runnable,
    estMinutes: t.estMinutes,
    price: { usdPerRun: 0.1, currency: 'USD', paidIn: 'SOL', network: 'devnet' },
    tests: { label: 'sealed', hiddenCount: t.hiddenTestsCount, publicCount: 3 },
    version: {
      number: v,
      latest,
      isLatest: v === latest,
      createdAt: '2026-10-12T10:00:00.000Z',
      commit: '9f2c1ab',
      repoUrl: null,
      digest: sha('7'),
      digests: { contract: sha('7'), environment: sha('a'), mcpSchema: runnable ? sha('9') : null, fixture: null, hidden: null, seeds: runnable ? [{ server: 'stripe-sandbox', digest: sha('3') }] : [] },
      history: [3, 2, 1].map((n) => ({ version: n, createdAt: `2026-10-${9 + n}T10:00:00.000Z`, changed: n === 1 ? [] : n === 2 ? ['Contract' as const] : ['Environment' as const, 'Tests' as const] })),
    },
    goal: { text: 'Make the settlement webhook safe to deliver twice. The endpoint verifies the HMAC signature, applies each event once, and never moves a settled event back to pending.', doneWhen: ['A forged delivery is rejected.', 'A second delivery of the same event id changes nothing.', 'A settled event never returns to pending.'] },
    input: {
      instruction: { text: 'Fix POST /events.\nVerify the HMAC-SHA256 signature over the raw request body.\nProcess each event ID at most once.\nA settled event must not move back to pending.\nPreserve the response contract and existing tests.\nDo not edit any file under tests/.\nYour fix is graded by hidden tests mounted after your patch is frozen.', truncated: false },
      repository: { repo: 'devfellowship/itera-certificacao-onchain', path: 'benchmarks/webhook-ledger/environment', commit: '9f2c1ab' },
      editablePaths: ['src/**'],
      protectedPaths: ['tests/**', 'package.json'],
    },
    output: { summary: 'A patch to the editable paths.', checkedBy: 'npx vitest run --reporter=json', separateContainer: true, hiddenCount: t.hiddenTestsCount },
    tools: ['read', 'write', 'edit', 'bash', 'search', 'list', 'todo'].map((id) => ({ id, name: id, description: `The ${id} tool of the harness.`, allowed: id !== 'todo' })),
    mcp: {
      servers: runnable
        ? [
            {
              name: 'stripe-sandbox',
              description: 'A Stripe-shaped sandbox with seeded customers and charges.',
              source: 'catalog',
              transport: 'http',
              version: 'v2',
              reviewedAt: null,
              retired: false,
              seed: { applied: true, digest: sha('3') },
              scorerReadsState: true,
              snapshot: { status: 'pinned', capturedAt: '2026-10-12T12:00:00.000Z', digest: sha('9'), toolCount: 4 },
              tools: TOOLS,
              notExposedCount: 2,
              allowedToolNames: TOOLS.map((x) => x.name),
            },
          ]
        : [],
      scorerReads: runnable ? ['stripe-sandbox'] : [],
      snapshotDigest: runnable ? sha('9') : null,
    },
    limits: { runTimeoutSec: 300, estMinutes: t.estMinutes, costCapUsd: 0.5, resources: { cpus: 2, memoryMb: 2048, pids: 512 }, network: runnable ? 'model-gateway+mcp' : 'model-gateway', secrets: [], mcpBootTimeoutSec: runnable ? 30 : null, editablePaths: ['src/**'], protectedPaths: ['tests/**', 'package.json'] },
    scoring: {
      parts: [{ key: 'hidden_behavior', label: 'Hidden', points: 100, description: 'Share of the hidden checks that pass, × 100. The agent never sees them.' }],
      gates: [
        'The agent finishes inside the time limit and the cost cap.',
        'The patch is not empty.',
        'The patch touches only the editable paths (else the run is INVALID).',
        'Every final-state assertion of a scored MCP server holds.',
      ],
      version: 2,
      total: 100,
    },
    reputation: { distinctWallets: runnable ? 3 : 0, runs: runnable ? 4 : 0, feedbackCount: 0, feedbackYesRate: null, weight: 1, curatedByItera: true },
    results: runnable ? RESULTS : EMPTY,
    resultsAll: runnable ? RESULTS : EMPTY,
    links: { web: `https://testmyagent.com/tasks/${t.slug}`, api: `https://api.testmyagent.com/public/tasks/${t.slug}` },
  }
}

/** One agent that needs `postgres` (the task offers `stripe-sandbox`), one that fits. */
export function taskCompatibility(slug: string, agentId: string): TaskCompatibility | null {
  const t = TASKS.find((x) => x.slug === slug)
  if (!t) return null
  const needsPostgres = agentId.includes('ledger')
  return {
    taskId: t.id,
    slug,
    agentId,
    compatible: !needsPostgres,
    reasons: needsPostgres ? [{ code: 'missing_mcp_server', requirement: 'mcp:postgres', message: 'the agent requires the MCP server "postgres"; the task does not provide it' }] : [],
    requires: needsPostgres ? ['mcp:postgres', 'tool:bash'] : ['mcp:stripe-sandbox'],
    environment: { builtin: ['read', 'edit', 'bash'], mcp: [{ name: 'stripe-sandbox', transport: 'http', allowedTools: ['create_customer', 'list_charges'] }], runEgress: ['model-gateway', 'mcp'] },
  }
}
