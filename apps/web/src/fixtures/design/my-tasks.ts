/**
 * My tasks fixtures (U20) in the shape of the U19 API (apps/api/src/http/my-tasks-router.ts).
 * The rows of screen 10 come from "10 My Tasks.dc.html"; the GitHub pins use the design repo
 * settlewise-labs/settlewise-agent. Fixture mode only. State is in memory and resets on reload.
 */
import type { GateRow, Task, TaskContract, TaskLayoutEntry, TaskLayoutResponse, TaskSourceInput, TaskStatus, TaskValidationRun, UserTaskDetail, UserTaskVersion } from '../../lib/api/types'
import { TAGS, TASKS } from './catalog'

const REPO = 'settlewise-labs/settlewise-agent'
const HEAD = '9f2c1ab4e7d0c3b5a8f6e2d1c0b9a8f7e6d5c4b3'
const OLDER = '4be192af7f3ac91e5a7b2c3d4e5f60718293a4b5'
const tag = (name: string) => TAGS.find((t) => t.name === name)!

/** The design's draft row. It is served only for source=mine, so the Task Filter of 01/03 keeps the catalog of its mock. */
export const MY_TASK_DRAFTS: Task[] = [
  {
    id: 'my_chargeback_window',
    slug: 'my_chargeback_window',
    name: 'Chargeback dispute window',
    description: 'Reject evidence submitted after the dispute deadline.',
    tags: [tag('Stripe API')],
    kind: 'user',
    visibility: 'private',
    status: 'draft',
    runnable: false,
    hiddenTestsCount: 5,
    estMinutes: 4,
    mine: true,
    agentsRunCount: 0,
    labels: ['sealed-tests'],
    version: 1,
  },
]

export function contractFor(folder: string, title: string, tools: string[], concepts: string[], est = 6): TaskContract {
  return {
    schema_version: '1.0',
    task: { name: `settlewise/${folder.split('/').pop()}`, version: '1', description: title },
    metadata: { title, tags: { tools, concepts } },
    instruction: 'instruction.md',
    environment: { dir: 'environment', install: ['npm', 'ci', '--ignore-scripts'], allow_internet: false, cpus: 2, memory_mb: 2048 },
    tests: { public: 'tests/public', hidden: 'tests/hidden' },
    solution: { patch: 'solution/solution.patch' },
    editable_paths: ['src/**'],
    protected_paths: ['tests/**', 'package.json', 'package-lock.json'],
    verifier: { cmd: ['npx', 'vitest', 'run', '{tests}', '--reporter=json', '--outputFile={report}'], report: 'vitest-json', timeout_sec: 300 },
    agent: { timeout_sec: 600 },
    est_minutes: est,
  }
}

export function readyRows(hidden: number): GateRow[] {
  return [
    { key: 'baseline', label: 'Baseline hidden tests', ok: true, value: 'FAIL as expected ✓' },
    { key: 'solution', label: 'Solution', ok: true, value: `${hidden} / ${hidden} PASS` },
    { key: 'repeatability', label: 'Repeatability', ok: true, value: '3 / 3 same result' },
    { key: 'verifier_time', label: 'Verifier time', ok: true, value: '41 s' },
  ]
}

function entries(c: TaskContract, hidden: number, missing: string[] = []): TaskLayoutEntry[] {
  const e: TaskLayoutEntry[] = [
    { key: 'taskJson', path: 'task.json', present: true },
    { key: 'instruction', path: c.instruction, present: true },
    { key: 'environment', path: c.environment.dir, present: true, files: 9 },
    { key: 'testsPublic', path: c.tests.public, present: true, files: 2 },
    { key: 'testsHidden', path: c.tests.hidden, present: true, files: hidden > 0 ? 2 : 0 },
    { key: 'solution', path: c.solution.patch, present: true },
  ]
  return e.map((x) => (missing.includes(x.path) ? { ...x, present: false, files: 0 } : x))
}

interface FixtureTask {
  detail: UserTaskDetail
  /** Fake gate: a validation becomes ready this many ms after it was queued. */
  validationReadyAt: number | null
}

function version(n: number, folder: string, sha: string, c: TaskContract, ready: boolean, hidden: number, createdAt: string): UserTaskVersion {
  return {
    id: `ver_${folder.replace(/\W+/g, '_')}_${n}`,
    version: n,
    source: 'github',
    github: { installationId: 1, repo: REPO, branch: 'main', commitSha: sha, shortSha: sha.slice(0, 7), path: folder },
    repoPrivate: true,
    testsVisibility: 'sealed',
    ranked: true,
    labels: ['sealed-tests'],
    runnable: ready,
    hiddenTestsCount: ready ? hidden : null,
    digests: ready ? { fixture: `sha256:${sha.slice(0, 12)}f1`, hidden: `sha256:${sha.slice(0, 12)}h2`, solution: `sha256:${sha.slice(0, 12)}s3` } : { fixture: null, hidden: null, solution: null },
    validatedAt: ready ? createdAt : null,
    validationRows: ready ? readyRows(hidden) : null,
    contract: c,
    createdAt,
  }
}

function seed(): Map<string, FixtureTask> {
  const m = new Map<string, FixtureTask>()
  const mk = (t: Task, status: TaskStatus, versions: UserTaskVersion[]) => {
    const latest = versions[0]
    const validation: TaskValidationRun | null =
      status === 'ready'
        ? { id: `val_${t.id}`, taskVersionId: latest.id, status: 'ready', repeats: 3, rows: latest.validationRows, error: null, createdAt: latest.createdAt, claimedAt: latest.createdAt, completedAt: latest.createdAt }
        : null
    m.set(t.id, {
      validationReadyAt: null,
      detail: {
        id: t.id,
        slug: t.slug,
        name: t.name,
        description: t.description,
        kind: 'user',
        visibility: 'private',
        status,
        estMinutes: t.estMinutes,
        tags: t.tags.map((g) => g.id),
        mine: true,
        runnable: versions.some((v) => v.runnable),
        runnableVersion: versions.find((v) => v.runnable)?.version ?? null,
        ranked: latest.ranked,
        labels: latest.labels,
        latestVersion: latest,
        versions,
        validation,
        createdAt: versions[versions.length - 1].createdAt,
        updatedAt: latest.createdAt,
      },
    })
  }
  const ledger = TASKS.find((t) => t.id === 'my_ledger_reconcile')!
  const lc = contractFor('tasks/ledger-reconcile', ledger.name, ['stripe-api', 'postgres'], [], 8)
  mk(ledger, 'ready', [
    version(2, 'tasks/ledger-reconcile', HEAD, lc, true, 16, '2026-10-12T09:20:00Z'),
    version(1, 'tasks/ledger-reconcile', OLDER, lc, true, 14, '2026-10-11T18:10:00Z'),
  ])
  const brl = TASKS.find((t) => t.id === 'my_brl_rounding')!
  mk(brl, 'ready', [version(1, 'tasks/brl-rounding', HEAD, contractFor('tasks/brl-rounding', brl.name, ['stripe-api'], ['money-math'], 3), true, 7, '2026-10-12T09:30:00Z')])
  const cb = MY_TASK_DRAFTS[0]
  mk(cb, 'draft', [version(1, 'tasks/chargeback-window', HEAD, contractFor('tasks/chargeback-window', cb.name, ['stripe-api'], [], 4), false, 5, '2026-10-12T10:02:00Z')])
  return m
}

let store: Map<string, FixtureTask> | null = null
const db = () => (store ??= seed())

/** Advances the fake gate: queued → running → ready, 4 s after the request. */
function tick(t: FixtureTask): UserTaskDetail {
  const d = t.detail
  const v = d.validation
  if (v && (v.status === 'queued' || v.status === 'running') && t.validationReadyAt != null) {
    if (Date.now() >= t.validationReadyAt) {
      const latest = d.versions[0]
      const hidden = 6
      const rows = readyRows(hidden)
      const now = new Date().toISOString()
      d.validation = { ...v, status: 'ready', rows, completedAt: now }
      d.versions[0] = { ...latest, runnable: true, hiddenTestsCount: hidden, validatedAt: now, validationRows: rows, digests: { fixture: 'sha256:fixture', hidden: 'sha256:hidden', solution: 'sha256:solution' } }
      d.latestVersion = d.versions[0]
      d.status = 'ready'
      d.runnable = true
      d.runnableVersion = latest.version
      t.validationReadyAt = null
    } else if (v.status === 'queued') {
      d.validation = { ...v, status: 'running', claimedAt: new Date().toISOString() }
    }
  }
  return d
}

export function fixtureTask(id: string): UserTaskDetail | null {
  const t = db().get(id)
  return t ? tick(t) : null
}

/** POST /tasks/layout: '.' has no task.json; a folder named *broken* misses tests/hidden; anything else reads. */
export function fixtureLayout(input: TaskSourceInput): TaskLayoutResponse | { error: string; status: number } {
  if (!input.repoFullName) return { error: 'repoFullName is required (owner/repo)', status: 400 }
  const path = (input.path ?? '.').trim().replace(/^\/+|\/+$/g, '') || '.'
  const sha = input.commitSha && /^[0-9a-f]{7,40}$/i.test(input.commitSha) ? (input.commitSha.length === 40 ? input.commitSha : HEAD) : HEAD
  const pin = { repoFullName: input.repoFullName, branch: input.branch || 'main', commitSha: sha, shortSha: sha.slice(0, 7), path, repoPrivate: true, testsVisibility: 'sealed' as const, ranked: true, labels: ['sealed-tests'] }
  if (path === '.') return { pin, layout: { ok: false, errorCode: 'no_task_json', error: `no task.json at the repo root in ${input.repoFullName}@${sha.slice(0, 7)}`, entries: [] }, contract: null }
  const folder = path.split('/').pop()!
  const title = folder.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  const c = contractFor(path, title, ['stripe-api'], ['idempotency'])
  if (/broken/.test(path)) {
    return { pin, layout: { ok: false, errorCode: 'missing_entries', error: 'task.json names entries that are missing at this commit: tests/hidden', entries: entries(c, 0, ['tests/hidden']) }, contract: c }
  }
  return { pin, layout: { ok: true, entries: entries(c, 6), fileCount: 18, totalBytes: 24_310 }, contract: c }
}

export function fixtureCreateTask(input: TaskSourceInput & { name?: string; description?: string; tags?: string[] }) {
  const r = fixtureLayout(input)
  if ('status' in r) return r
  if (!r.layout.ok || !r.contract) return { error: r.layout.error ?? 'layout check failed', status: 422 }
  const id = `my_${Date.now().toString(36)}`
  const v = version(1, r.pin.path, r.pin.commitSha, r.contract, false, 0, new Date().toISOString())
  v.github = { ...v.github, repo: r.pin.repoFullName, branch: r.pin.branch }
  const detail: UserTaskDetail = {
    id,
    slug: id,
    name: input.name || r.contract.metadata?.title || r.contract.task.name,
    description: input.description ?? r.contract.task.description ?? '',
    kind: 'user',
    visibility: 'private',
    status: 'draft',
    estMinutes: r.contract.est_minutes,
    tags: input.tags ?? [],
    mine: true,
    runnable: false,
    runnableVersion: null,
    ranked: true,
    labels: ['sealed-tests'],
    latestVersion: v,
    versions: [v],
    validation: null,
    createdAt: v.createdAt,
    updatedAt: v.createdAt,
  }
  db().set(id, { detail, validationReadyAt: null })
  return { task: detail, version: v, layout: r.layout }
}

export function fixturePatchTask(id: string, patch: { name?: string; description?: string; tags?: string[] }) {
  const t = db().get(id)
  if (!t) return null
  Object.assign(t.detail, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { updatedAt: new Date().toISOString() })
  return t.detail
}

export function fixtureDeleteTask(id: string) {
  return db().delete(id)
}

export function fixtureAddVersion(id: string, input: Partial<TaskSourceInput>) {
  const t = db().get(id)
  if (!t) return null
  const latest = t.detail.versions[0]
  const r = fixtureLayout({ repoFullName: input.repoFullName ?? latest.github.repo, branch: input.branch ?? latest.github.branch, commitSha: input.commitSha, path: input.path ?? latest.github.path })
  if ('status' in r) return r
  if (!r.layout.ok || !r.contract) return { error: r.layout.error ?? 'layout check failed', status: 422 }
  const same = t.detail.versions.find((v) => v.github.commitSha === r.pin.commitSha && v.github.path === r.pin.path)
  // U34: same pin = same folder → the existing version comes back (HTTP 200, unchanged).
  if (same) return { version: same, layout: r.layout, unchanged: true }
  const v = version(latest.version + 1, r.pin.path, r.pin.commitSha, r.contract, false, 0, new Date().toISOString())
  t.detail.versions.unshift(v)
  t.detail.latestVersion = v
  t.detail.status = 'draft'
  t.detail.validation = null
  return { version: v, layout: r.layout }
}

export function fixtureValidate(id: string, n: number) {
  const t = db().get(id)
  if (!t) return null
  const v = t.detail.versions.find((x) => x.version === n)
  if (!v) return null
  const now = new Date().toISOString()
  t.detail.validation = { id: `val_${Date.now().toString(36)}`, taskVersionId: v.id, status: 'queued', repeats: 3, rows: null, error: null, createdAt: now, claimedAt: null, completedAt: null }
  t.detail.status = 'validating'
  t.validationReadyAt = Date.now() + 4000
  return { validationId: t.detail.validation.id, created: true, version: n, validation: t.detail.validation }
}
