/** Evaluations of 04 Running Evaluation, 05 Evaluation Results and 09 My Evaluations (design mocks). */
import type { EvaluationDetail, EvaluationListItem, EvaluationUiState, EventToneApi, Outcome, PublicEvaluation, StageKey, StageState, TaskStage } from '../../lib/api/types'
import { lamportsFor, solFor, TAGS, TASKS } from './catalog'
import { ME } from './agents'

const taskByName = (name: string) => TASKS.find((t) => t.name === name)!

// ---------- 09 My evaluations ----------
const RAW = [
  { agent: 'Settlewise', by: ME, id: 'ev_7f3a', date: '2026-10-12T14:24:00Z', tasks: ['Duplicate settlement webhook', 'Partial refund race condition', 'Idempotency keys on retry', 'Missing index on hot query'], pass: 3, fail: 1, invalid: 0, score: 78.6, status: 'issued', priv: false },
  { agent: 'Settlewise', by: ME, id: 'ev_a21c', date: '2026-10-12T15:02:00Z', tasks: ['Duplicate settlement webhook'], pass: 0, fail: 0, invalid: 0, score: null, status: 'in_progress', priv: false },
  { agent: 'Ledgerline', by: 'Mara Okafor', id: 'ev_5b90', date: '2026-10-11T10:00:00Z', tasks: ['Ledger reconcile after outage', 'BRL payout rounding'], pass: 1, fail: 1, invalid: 0, score: 90.6, status: 'issued', priv: true },
  { agent: 'Querytune', by: ME, id: 'ev_3e07', date: '2026-10-09T10:00:00Z', tasks: ['Missing index on hot query', 'Ledger reconcile after outage', 'BRL payout rounding'], pass: 0, fail: 3, invalid: 0, score: 73.8, status: 'issued', priv: true },
  { agent: 'Schemasmith', by: 'Ana Ferreira', id: 'ev_c4d2', date: '2026-10-09T09:00:00Z', tasks: ['Ledger reconcile after outage'], pass: 0, fail: 1, invalid: 0, score: 62.5, status: 'issued', priv: true },
  { agent: 'Patchwright', by: 'Diego Santos', id: 'ev_09fa', date: '2026-10-08T09:00:00Z', tasks: ['Fix failing CI and open a PR'], pass: 0, fail: 0, invalid: 1, score: null, status: 'review', priv: false },
] as const

export const EVALUATIONS: EvaluationListItem[] = RAW.map((e) => ({
  id: e.id,
  shortId: e.id,
  slug: e.id === 'ev_7f3a' ? 'settlewise-7f3a' : null,
  agent: { name: e.agent, initials: e.agent.slice(0, 2).toUpperCase(), authorName: e.by, isMine: e.by === ME },
  createdAt: e.date,
  feeSol: solFor(e.tasks.length),
  tasks: e.tasks.map((n) => ({ id: taskByName(n).id, name: n })),
  counts: { pass: e.pass, fail: e.fail, invalid: e.invalid },
  score: e.score,
  status: e.status,
  share: e.priv ? { kind: 'private', url: null } : e.id === 'ev_7f3a' ? { kind: 'link', url: '/e/settlewise-7f3a' } : { kind: 'none', url: null },
}))

export function evaluationTotals(list: EvaluationListItem[]) {
  const lamports = RAW.reduce((s, e) => s + lamportsFor(e.tasks.length), 0)
  return {
    spentLamports: lamports,
    spentSol: (lamports / 1e9).toFixed(5),
    usd: Math.round(RAW.reduce((s, e) => s + e.tasks.length * 0.1, 0) * 100) / 100,
    counts: { all: list.length, mineAgents: list.filter((e) => e.agent.isMine).length, otherAgents: list.filter((e) => !e.agent.isMine).length },
  }
}

// ---------- 04 Running evaluation, four states ----------
const T4 = ['Duplicate settlement webhook', 'Partial refund race condition', 'Idempotency keys on retry', 'Missing index on hot query']
const STAGE_KEYS: StageKey[] = ['contract', 'agent_calls', 'grading', 'manifest', 'attestation']
type Row = [string, string, string, string, string]
const mmss = (s: string) => {
  if (!s.includes(':')) return null
  const [m, sec] = s.split(':').map(Number)
  return (m * 60 + sec) * 1000
}
const STAGE_WORD: Record<string, TaskStage> = { Queued: 'queued', Grading: 'grading', 'Awaiting artifact': 'awaiting_artifact', Graded: 'graded', 'Timed out': 'timed_out' }
const OUTCOME: Record<string, Outcome | null> = { pass: 'PASS', fail: 'FAIL', invalid: 'INVALID', pend: null }

const PH: Record<EvaluationUiState, { elapsed: string; stages: Array<[StageState, string]>; tasks: Row[]; log: Array<[string, EventToneApi, string, string]> }> = {
  queued: {
    elapsed: '00:04',
    stages: [['active', 'Freezing 4 contracts'], ['wait', 'Queued'], ['wait', 'Queued'], ['wait', '—'], ['wait', '—']],
    tasks: [['Queued', 'idle', '— / 14', '—', 'pend'], ['Queued', 'idle', '— / 18', '—', 'pend'], ['Queued', 'idle', '— / 11', '—', 'pend'], ['Queued', 'idle', '— / 8', '—', 'pend']],
    log: [['00:00', 'ok', 'Fee paid', '0.00367 SOL · tx 2Wb8…k3Ps'], ['00:01', 'ok', 'Repo checked out', '9f2c1ab'], ['00:02', 'live', 'Freezing contracts', 'hashing 4 task specs']],
  },
  running: {
    elapsed: '06:12',
    stages: [['done', 'sha256 4be1…92af'], ['active', '2 of 4 returned'], ['active', '1 of 4 graded'], ['wait', '—'], ['wait', '—']],
    tasks: [['Graded', 'ok', '14 / 14', '04:12', 'pass'], ['Grading', 'live', '9 / 18', '05:48', 'pend'], ['Awaiting artifact', 'live', '— / 11', '00:41', 'pend'], ['Queued', 'idle', '— / 8', '—', 'pend']],
    log: [['00:00', 'idle', 'Evaluation created', '4 tasks'], ['00:03', 'ok', 'Contracts frozen', '4be1…92af'], ['00:04', 'idle', 'Called agent', 'tsk_webhook_dup'], ['01:58', 'ok', 'Artifact frozen', 'a91c…04de'], ['04:12', 'ok', 'Graded PASS', '14/14 tests'], ['04:13', 'idle', 'Called agent', 'tsk_refund_race'], ['05:31', 'ok', 'Artifact frozen', 'e27b…5f10'], ['05:32', 'idle', 'Called agent', 'tsk_idem_keys'], ['06:12', 'live', 'Grading', 'tsk_refund_race · 9/18']],
  },
  issuing: {
    elapsed: '14:38',
    stages: [['done', 'sha256 4be1…92af'], ['done', '4 of 4 returned'], ['done', '3 PASS · 1 FAIL'], ['done', 'sha256 7f3a…c91e'], ['active', 'Awaiting confirmation']],
    tasks: [['Graded', 'ok', '14 / 14', '04:12', 'pass'], ['Graded', 'ok', '12 / 18', '07:03', 'fail'], ['Graded', 'ok', '11 / 11', '03:27', 'pass'], ['Graded', 'ok', '8 / 8', '02:09', 'pass']],
    log: [['04:12', 'ok', 'Graded PASS', 'tsk_webhook_dup'], ['11:16', 'bad', 'Graded FAIL', 'tsk_refund_race · 12/18'], ['13:02', 'ok', 'Graded PASS', 'tsk_idem_keys'], ['14:21', 'ok', 'Graded PASS', 'tsk_pg_index'], ['14:24', 'ok', 'Manifest written', '7f3a…c91e'], ['14:26', 'idle', 'Attestation submitted', 'SAS · devnet'], ['14:38', 'live', 'Awaiting confirmation', 'tx 5h7k…Qm9w']],
  },
  error: {
    elapsed: '12:51',
    stages: [['done', 'sha256 4be1…92af'], ['error', '1 call timed out'], ['done', '3 of 4 graded'], ['wait', 'Blocked'], ['wait', '—']],
    tasks: [['Graded', 'ok', '14 / 14', '04:12', 'pass'], ['Graded', 'ok', '12 / 18', '07:03', 'fail'], ['Timed out', 'bad', '— / 11', '05:00', 'invalid'], ['Graded', 'ok', '8 / 8', '02:09', 'pass']],
    log: [['04:12', 'ok', 'Graded PASS', 'tsk_webhook_dup'], ['06:32', 'idle', 'Called agent', 'tsk_idem_keys'], ['11:16', 'bad', 'Graded FAIL', 'tsk_refund_race · 12/18'], ['11:32', 'bad', 'Agent timeout', 'tsk_idem_keys · 300 s'], ['11:33', 'idle', 'Marked INVALID', 'no artifact'], ['12:51', 'ok', 'Graded PASS', 'tsk_pg_index · 8/8'], ['12:51', 'live', 'Waiting on you', 'retry or continue']],
  },
}

/** Fixture ids of the four 04 states: ev_queued, ev_running, ev_issuing, ev_error. ev_7f3a = running. */
export function evaluationDetail(id: string): EvaluationDetail | null {
  const state = (id.replace(/^ev_/, '') as EvaluationUiState) in PH ? (id.replace(/^ev_/, '') as EvaluationUiState) : id === 'ev_7f3a' || id === 'ev_a21c' ? 'running' : null
  if (!state) return null
  const p = PH[state]
  const tasks = p.tasks.map((r, i) => {
    const t = taskByName(T4[i])
    const [passed, total] = r[2].split(' / ')
    const outcome = OUTCOME[r[4]]
    return {
      runId: `run_${i + 1}`,
      taskId: t.id,
      name: t.name,
      slug: t.slug,
      stage: STAGE_WORD[r[0]],
      testsPassed: passed === '—' ? null : Number(passed),
      testsTotal: Number(total),
      durationMs: mmss(r[3]),
      outcome,
      score: outcome === 'PASS' ? 100 : outcome === 'FAIL' ? 66.7 : null,
    }
  })
  const counts = { pass: tasks.filter((t) => t.outcome === 'PASS').length, fail: tasks.filter((t) => t.outcome === 'FAIL').length, invalid: tasks.filter((t) => t.outcome === 'INVALID').length }
  return {
    id,
    shortId: id,
    slug: 'settlewise-7f3a',
    status: state === 'error' ? 'review' : state === 'issuing' ? 'issuing' : state === 'queued' ? 'pending' : 'in_progress',
    uiState: state,
    elapsedMs: mmss(p.elapsed)!,
    agent: { name: 'Settlewise', commit: '9f2c1ab', initials: 'SE' },
    model: 'Claude Fable 5.1',
    taskCount: 4,
    stages: p.stages.map(([s, detail], i) => ({ key: STAGE_KEYS[i], state: s, detail })),
    tasks,
    events: p.log.map(([t, tone, label, detail]) => ({ tMs: mmss(t)!, tone, label, detail })),
    proofs: state === 'issuing' ? tasks.map((t) => ({ runId: t.runId, status: 'pending' as const, txSig: '5h7kQm9w', nftMint: null, proofHash: '7f3a…c91e' })) : [],
    score: state === 'issuing' ? 78.6 : null,
    counts,
    isPublic: true,
    shareUrl: null,
  }
}

// ---------- 05 Public profile ----------
const P5: Array<[string, Outcome, number, number, string]> = [
  ['Duplicate settlement webhook', 'PASS', 14, 14, '04:12'],
  ['Partial refund race condition', 'FAIL', 12, 18, '07:03'],
  ['Idempotency keys on retry', 'PASS', 11, 11, '03:27'],
  ['Missing index on hot query', 'PASS', 8, 8, '02:09'],
]

export const PUBLIC_EVALUATION: PublicEvaluation = {
  slug: 'settlewise-7f3a',
  hash: '7f3a2be19c04d6e81a5f3b72c9e0d41a86b5f2c7e3d90a1b4c6e8f02a7d5c91e',
  issuedAt: '2026-10-12T14:38:00Z',
  agent: { name: 'Settlewise', slug: 'settlewise', initials: 'SE', authorName: ME, modelLabel: 'Claude Fable 5.1', commit: '9f2c1ab', description: 'Fixes settlement, refund and webhook bugs in payment services.' },
  tags: ['Stripe API', 'Idempotency', 'Concurrency', 'Postgres', 'Prisma'].map((n) => TAGS.find((t) => t.name === n)!),
  score: 78.6,
  counts: { pass: 3, fail: 1, invalid: 0 },
  testsPassed: 45,
  testsTotal: 51,
  tasks: P5.map(([name, outcome, passed, total, dur]) => {
    const t = taskByName(name)
    // Failed cells sit at the end of the row in the mock; order is execution order, booleans only.
    const testResults = Array.from({ length: total }, (_, i) => i < passed)
    return { name, description: t.description, tags: t.tags, outcome, testResults, testsPassed: passed, testsTotal: total, durationMs: mmss(dur) }
  }),
  record: {
    network: 'Solana devnet',
    status: 'Confirmed',
    issuedAt: '2026-10-12T14:38:00Z',
    proofs: [{ txSig: '5h7kXq2VnB8eYw3rTzL9cPpA4sD6fGhJ1kMuN7oR2tQm9w', attestationAddress: null, nftMint: null, proofHash: '7f3a2be19c04d6e81a5f3b72c9e0d41a86b5f2c7e3d90a1b4c6e8f02a7d5c91e' }],
  },
  disclaimer: 'Results describe commit 9f2c1ab on these four tasks only. They are not a guarantee of behavior on other work.',
}
