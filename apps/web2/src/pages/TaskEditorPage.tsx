/**
 * Task editor — /tasks/new and /tasks/:id/edit (plan 20261012-itera-testmyagent-ui-refactor, U20).
 * Not in the design: built from the designer handoff (U26, "New task / Task editor") on the layout
 * of screen 02. API: U19 (apps/api/src/http/my-tasks-router.ts).
 *
 * Decisions that shape this page:
 *  - Gate Q4: the source is a GitHub repo through the App, pinned to branch + commit. No upload.
 *  - Gate Q5: no copy. The API reads the task folder at the pinned commit, every time.
 *  - U32: the repo's task.json wins over the form. The CONTRACT card shows what the API read;
 *    name, description and tags are the metadata the user edits here.
 *  - Q7: a private repo seals the hidden tests (ranked); a public repo has open tests (unranked).
 *  - A new commit is a new version. A version never changes.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../lib/api'
import type { GateRow, Tag, TaskContract, TaskLayout, TaskStatus, TaskSourceInput, TestsVisibility, UserTaskDetail } from '../lib/api'
import { Badge, Breadcrumb, Button, ButtonLink, Card, Chip, CodePanel, Field, Input, KeyValue, RadioCard, StatusChip, TagPill, type Tone } from '../tma/ui'
import { describeError } from './add-agent/errors'
import { GithubPinCard, SampleRepoNotice, type InstallCopy } from './add-agent/GithubSourceCard'
import { cleanAgentPath, useGithubPin } from './add-agent/useGithubSource'
import { useLoad } from './add-agent/useLoad'
import { EnvironmentCard } from './task-editor/EnvironmentCard'
import { TestsLabel } from './task-editor/labels'
import { useTaskCandidates } from './task-editor/useTaskCandidates'
import { useTaskLayout, type LayoutCheck } from './task-editor/useTaskLayout'
import './add-agent/add-agent.css'
import './task-editor/task-editor.css'

const NAME_MAX = 60
const DESC_MAX = 90
const TAGS_MAX = 8
const POLL_MS = 3000

const INSTALL_COPY: InstallCopy = {
  intro: 'We read your task from the repo at a pinned commit. Nothing is copied: the hidden tests stay in your repo. Read-only, on the repos you pick.',
  tile3: { title: 'Point to the task folder', detail: 'task.json, tests/', mono: true },
}

/** Badge of the VALIDATION card (handoff: Draft grey · Validating warning · Ready success · Invalid danger). */
const GATE_BADGE: Record<TaskStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  validating: { label: 'Validating', tone: 'warning' },
  ready: { label: 'Ready', tone: 'success' },
  invalid: { label: 'Invalid', tone: 'danger' },
}

/** The four gate steps, in order (handoff VALIDATION rows). */
const GATE_STEPS: Array<{ key: string; label: string }> = [
  { key: 'baseline', label: 'Baseline hidden tests' },
  { key: 'solution', label: 'Solution' },
  { key: 'repeatability', label: 'Repeatability' },
  { key: 'verifier_time', label: 'Verifier time' },
]

const LAYOUT_LABEL: Record<string, string> = {
  taskJson: 'task.json',
  instruction: 'instruction',
  environment: 'environment/',
  testsPublic: 'tests/public/',
  testsHidden: 'tests/hidden/',
  solution: 'solution/',
}
const EXPECTED_LAYOUT = ['task.json', 'instruction.md', 'environment/', 'tests/public/', 'tests/hidden/', 'solution/']

/** The example contract of the right column before a task.json is read. */
const EXAMPLE_CONTRACT = {
  schema_version: '1.0',
  task: { name: 'acme/ledger-reconcile', version: '1' },
  metadata: { title: 'Ledger reconcile after outage', tags: { tools: ['stripe-api', 'postgres'], concepts: [] } },
  instruction: 'instruction.md',
  environment: { dir: 'environment', allow_internet: false },
  tests: { public: 'tests/public', hidden: 'tests/hidden' },
  solution: { patch: 'solution/solution.patch' },
  editable_paths: ['src/**'],
  protected_paths: ['tests/**', 'package.json'],
  verifier: { cmd: ['npx', 'vitest', 'run', '--reporter=json'], timeout_sec: 300 },
  agent: { timeout_sec: 600 },
  est_minutes: 6,
}

const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError && (e.status === 409 || e.status === 422 || e.status === 400)) return e.message
  return describeError(e, fallback)
}

// ---------------------------------------------------------------------------------------------
// Cards

function IdentityCard({
  name,
  setName,
  description,
  setDescription,
  tags,
  toggleTag,
  tagList,
  locked,
}: {
  name: string
  setName: (s: string) => void
  description: string
  setDescription: (s: string) => void
  tags: string[]
  toggleTag: (id: string) => void
  tagList: Tag[] | null
  locked: boolean
}) {
  const kinds: Array<{ kind: Tag['kind']; label: string }> = [
    { kind: 'tool', label: 'Tools' },
    { kind: 'concept', label: 'Concepts' },
  ]
  return (
    <Card className="ta-card" data-testid="identity-card">
      <span className="tma-label">Identity</span>
      <Field label="Name" htmlFor="te-name" error={name.trim() === '' && !locked ? 'Required.' : undefined}>
        <Input id="te-name" value={name} maxLength={NAME_MAX} disabled={locked} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="tma-field">
        <label className="ta-count" htmlFor="te-desc">
          <span>One-line description</span>
          <span className={description.length >= DESC_MAX ? 'ta-count__n ta-count__n--max' : 'ta-count__n'}>
            {description.length}/{DESC_MAX}
          </span>
        </label>
        <Input id="te-desc" value={description} disabled={locked} onChange={(e) => setDescription(e.target.value.slice(0, DESC_MAX))} />
      </div>
      <div className="te-tags" data-testid="tag-picker">
        {kinds.map(({ kind, label }) => {
          const list = (tagList ?? []).filter((t) => t.kind === kind)
          return (
            <div className="te-tags__row" key={kind}>
              <span className="te-tags__label">{label}</span>
              <span className="te-tags__chips">
                {tagList == null && <span className="te-muted">Loading tags…</span>}
                {tagList != null && list.length === 0 && <span className="te-muted">None yet.</span>}
                {locked
                  ? list.filter((t) => tags.includes(t.id)).map((t) => <TagPill key={t.id}>{t.name}</TagPill>)
                  : list.map((t) => (
                      <Chip key={t.id} selected={tags.includes(t.id)} onToggle={() => toggleTag(t.id)}>
                        {t.name}
                      </Chip>
                    ))}
              </span>
            </div>
          )
        })}
        {!locked && <span className="ta-help">Pick at least one tag, up to {TAGS_MAX}. Tags place the task in the Task Filter.</span>}
      </div>
    </Card>
  )
}

function LayoutTree({ layout, contract }: { layout: TaskLayout | null; contract: TaskContract | null }) {
  const entries = layout?.entries ?? []
  return (
    <div className="te-tree" data-testid="layout-tree">
      {entries.length === 0
        ? EXPECTED_LAYOUT.map((p) => (
            <span className="te-tree__row" key={p}>
              <span className="te-tree__mark te-tree__mark--idle">·</span>
              <span>{p}</span>
            </span>
          ))
        : entries.map((e) => (
            <span className="te-tree__row" key={e.key} data-testid={`layout-${e.key}`}>
              <span className={e.present ? 'te-tree__mark te-tree__mark--ok' : 'te-tree__mark te-tree__mark--bad'}>{e.present ? '✓' : '✗'}</span>
              <span>
                {e.path}
                {LAYOUT_LABEL[e.key] && !e.path.startsWith(LAYOUT_LABEL[e.key].replace(/\/$/, '')) && <span className="te-tree__note"> ({LAYOUT_LABEL[e.key]})</span>}
              </span>
              <span className="te-tree__note">
                {e.present ? (e.files != null ? `${e.files} ${e.files === 1 ? 'file' : 'files'}` : '') : `Missing: ${e.path}`}
              </span>
            </span>
          ))}
      {contract && layout?.ok && layout.fileCount != null && <span className="te-tree__foot">{layout.fileCount} files read at the pinned commit</span>}
    </div>
  )
}

function layoutMessage(check: LayoutCheck): ReactNode {
  if (check.phase === 'running')
    return (
      <div className="ta-verify" data-testid="layout-running">
        <Badge tone="warning">
          <span className="ta-spin" />
          Checking
        </Badge>
        <span className="ta-verify__text">Reading task.json…</span>
      </div>
    )
  if (check.phase === 'error')
    return (
      <div className="ta-verify" data-testid="layout-error">
        <Badge tone="danger" dot>
          Not checked
        </Badge>
        <span className="ta-verify__text ta-verify__text--bad">{check.message}</span>
      </div>
    )
  if (check.phase !== 'done') return null
  const { layout, pin } = check.data
  if (layout.ok)
    return (
      <div className="ta-verify" data-testid="layout-ok">
        <Badge tone="success" dot>
          Found
        </Badge>
        <span className="ta-verify__text">
          task.json at {pin.path === '.' ? 'the repo root' : pin.path} · {pin.shortSha}
        </span>
      </div>
    )
  return (
    <div className="ta-stack" style={{ gap: 8 }} data-testid="layout-fail">
      <div className="ta-verify">
        <Badge tone="danger" dot>
          {layout.errorCode === 'missing_entries' ? 'Missing files' : layout.errorCode === 'no_task_json' ? 'No task.json' : 'Invalid'}
        </Badge>
        <span className="ta-verify__text ta-verify__text--bad">{layout.error}</span>
      </div>
      {layout.schemaErrors && layout.schemaErrors.length > 0 && (
        <ul className="te-schema-errors" data-testid="schema-errors">
          {layout.schemaErrors.slice(0, 8).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TestsAside({ visibility }: { visibility: TestsVisibility | null }) {
  if (!visibility) return null
  return (
    <div className="te-tests-aside" data-testid="tests-visibility">
      <TestsLabel visibility={visibility} />
      <span className="ta-help">
        {visibility === 'open'
          ? 'In a public repo, agent authors can read the tests. Runs on this task are unranked.'
          : 'The repo is private: agents and their authors never see the hidden tests. Runs on this task can be ranked.'}
      </span>
    </div>
  )
}

function ContractCard({ contract, shortSha }: { contract: TaskContract | null; shortSha: string | null }) {
  const rows = contract
    ? [
        { key: 'Instruction', value: <span className="te-mono">{contract.instruction}</span> },
        { key: 'Editable paths', value: <span className="te-mono">{contract.editable_paths.join(', ')}</span> },
        { key: 'Protected paths', value: <span className="te-mono">{contract.protected_paths.join(', ')}</span> },
        { key: 'Verifier command', value: <span className="te-mono">{contract.verifier.cmd.join(' ')}</span> },
        { key: 'Verifier timeout', value: `${contract.verifier.timeout_sec} s` },
        { key: 'Agent timeout', value: `${contract.agent.timeout_sec} s` },
        { key: 'Est. minutes', value: String(contract.est_minutes) },
      ]
    : []
  return (
    <Card className="ta-card" data-testid="contract-card">
      <div className="ta-card__top">
        <span className="tma-label">Contract</span>
        <span className="te-meta">{contract && shortSha ? `from task.json · ${shortSha}` : 'from task.json'}</span>
      </div>
      {contract ? (
        <>
          <div className="te-kv">
            <KeyValue rows={rows} />
          </div>
          <span className="ta-help">The task.json in your repo is the contract. To change it, edit the file, push, and pin the new commit: that is a new version.</span>
        </>
      ) : (
        <span className="ta-help">Pick the repo, branch, path and commit. The contract is read from task.json at that commit.</span>
      )}
    </Card>
  )
}

function GateRows({ rows, running }: { rows: GateRow[] | null; running: boolean }) {
  const byKey = new Map((rows ?? []).map((r) => [r.key, r]))
  const extra = (rows ?? []).filter((r) => r.key !== 'mcp' && !GATE_STEPS.some((s) => s.key === r.key))
  // U31: a task with MCP servers gets an ENVIRONMENT group (the gate's MCP step) above the TESTS rows.
  const mcp = byKey.get('mcp')
  return (
    <div className="te-gate" data-testid="validation-rows">
      {mcp && (
        <>
          <div className="te-gate__group">Environment</div>
          <div className={`te-gate__row ${mcp.ok ? 'te-gate__row--ok' : 'te-gate__row--bad'}`} data-testid="validation-row" data-gate="mcp">
            <span className="te-gate__key">{mcp.label}</span>
            <span className="te-gate__value">{mcp.ok ? mcp.value : `${mcp.value}${/✗/.test(mcp.value) ? '' : ' ✗'}`}</span>
          </div>
          <div className="te-gate__group">Tests</div>
        </>
      )}
      {extra.map((r) => (
        <div className="te-gate__row te-gate__row--bad" key={r.key} data-testid="validation-extra">
          <span className="te-gate__key">{r.label}</span>
          <span className="te-gate__value">{r.value}</span>
        </div>
      ))}
      {GATE_STEPS.map((s) => {
        const r = byKey.get(s.key)
        let value: ReactNode
        let cls = 'te-gate__row'
        if (r) {
          value = r.ok ? r.value : `${r.value}${/✗/.test(r.value) ? '' : ' ✗'}`
          cls += r.ok ? ' te-gate__row--ok' : ' te-gate__row--bad'
        } else if (running) {
          value = (
            <span className="te-gate__wait">
              <span className="ta-spin" />
              Running
            </span>
          )
        } else value = <span className="te-muted">Not run yet</span>
        return (
          <div className={cls} key={s.key} data-testid="validation-row" data-gate={s.key}>
            <span className="te-gate__key">{s.label}</span>
            <span className="te-gate__value">{value}</span>
          </div>
        )
      })}
    </div>
  )
}

function useElapsed(since: string | null, on: boolean): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [on])
  if (!on || !since) return null
  const s = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

function ValidationCard({
  detail,
  canValidate,
  busy,
  onValidate,
  reason,
}: {
  detail: UserTaskDetail | null
  canValidate: boolean
  busy: boolean
  onValidate: () => void
  reason: string | null
}) {
  const status: TaskStatus = detail?.status ?? 'draft'
  const v = detail?.validation ?? null
  const platformError = v?.status === 'error'
  const running = status === 'validating' || v?.status === 'queued' || v?.status === 'running'
  const rows = v?.rows ?? (status === 'ready' || status === 'invalid' ? (detail?.latestVersion?.validationRows ?? null) : null)
  const elapsed = useElapsed(v?.createdAt ?? null, running)
  const badge = platformError && !running ? { label: 'Review', tone: 'warning' as Tone } : GATE_BADGE[status]
  return (
    <Card className="ta-card" data-testid="validation-card">
      <div className="ta-card__top">
        <span className="tma-label">Validation</span>
        <Badge tone={badge.tone} testId={`gate-${platformError && !running ? 'review' : status}`}>
          {badge.label}
        </Badge>
      </div>
      <div className="te-gate__intro">
        <span className="ta-help">
          The gate runs your tests in a sandbox: hidden tests fail on the baseline, pass with your solution, give the same result 3 times, and end inside the verifier timeout.
        </span>
        <Button variant="secondary" size={32} disabled={!canValidate || busy || running} onClick={onValidate} data-testid="validate-inline">
          {running ? 'Validating…' : busy ? 'Saving…' : status === 'invalid' || platformError ? 'Validate again' : 'Validate task'}
        </Button>
      </div>
      {running && (
        <span className="te-elapsed" data-testid="gate-elapsed">
          {v?.status === 'queued' ? 'Queued' : 'Running'} · {elapsed ?? '0 s'} · updates every 3 s
        </span>
      )}
      {platformError && !running && (
        <span className="ta-error" role="alert" data-testid="gate-platform-error">
          We had a problem on our side. Run the gate again. Nothing on your task changed.
        </span>
      )}
      <GateRows rows={platformError ? null : rows} running={running} />
      {!canValidate && reason && !running && <span className="ta-help">{reason}</span>}
    </Card>
  )
}

function VersionsCard({ detail, onNewVersion, newVersionOff }: { detail: UserTaskDetail; onNewVersion: () => void; newVersionOff: boolean }) {
  return (
    <Card className="ta-card ta-card--tight" data-testid="versions-card">
      <div className="ta-card__top">
        <span className="tma-label">Versions</span>
        <button type="button" className="te-link" onClick={onNewVersion} disabled={newVersionOff} data-testid="new-version">
          New version
        </button>
      </div>
      <div className="te-versions">
        {detail.versions.map((v, i) => (
          <div className="te-version" key={v.id} data-testid="version-row">
            <span className="te-version__n">v{v.version}</span>
            <span className="te-version__pin" title={`${v.github.repo}@${v.github.commitSha}`}>
              {v.github.repo}@{v.github.shortSha} <span className="te-muted">· {v.github.branch} · {v.github.path}</span>
            </span>
            <span className="te-version__date">{fmtDate(v.createdAt)}</span>
            <span className="te-version__state">
              {v.runnable ? <StatusChip status="ready" /> : i === 0 ? <Badge tone={GATE_BADGE[detail.status].tone}>{GATE_BADGE[detail.status].label}</Badge> : <Badge tone="neutral">Not validated</Badge>}
            </span>
          </div>
        ))}
      </div>
      <span className="ta-help">A new commit is a new version. A version never changes; runs and proofs name the version they used.</span>
    </Card>
  )
}

function PinSummary({ detail, onChange, changeOff }: { detail: UserTaskDetail; onChange: () => void; changeOff: boolean }) {
  const v = detail.latestVersion!
  return (
    <div className="ta-stack" data-testid="pin-summary">
      <div className="te-kv">
        <KeyValue
          rows={[
            { key: 'Repository', value: <span className="te-mono">{v.github.repo}</span> },
            { key: 'Branch', value: <span className="te-mono">{v.github.branch}</span> },
            { key: 'Path', value: <span className="te-mono">{v.github.path}</span> },
            { key: 'Pinned commit', value: <span className="te-mono">{v.github.shortSha} · v{v.version}</span> },
          ]}
        />
      </div>
      {!changeOff && (
        <div>
          <Button variant="secondary" size={32} onClick={onChange} data-testid="change-commit">
            Pin another commit
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Page

type PackSnapshot = { name: string; description: string; latestVersion: { version: number; packId: string; packVersion: string; fixtureDigest: string | null } | null }
type Loaded = { state: 'new' } | { state: 'loading' } | { state: 'missing' } | { state: 'error'; message: string } | { state: 'ready'; detail: UserTaskDetail } | { state: 'snapshot'; detail: PackSnapshot }

export function TaskEditorPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isNew = !id || id === 'new'
  const [loaded, setLoaded] = useState<Loaded>(isNew ? { state: 'new' } : { state: 'loading' })
  const detail = loaded.state === 'ready' ? loaded.detail : null

  const tagsLoad = useLoad(() => api.tags(), [])
  const tagList = tagsLoad.data?.tags ?? (tagsLoad.status === 'error' ? [] : null)

  // Identity (metadata the user edits; U32).
  const [name, setName] = useState<string | null>(null)
  const [description, setDescription] = useState<string | null>(null)
  const [tags, setTags] = useState<string[] | null>(null)

  // Source: editable for a new task, or after "Pin another commit" / "New version".
  const pin = useGithubPin()
  const [path, setPath] = useState('.')
  const [editingSource, setEditingSource] = useState(isNew)

  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const reload = useCallback(async () => {
    if (isNew || !id) return
    try {
      const r = await api.myTask(id)
      if (r.task?.mine && String((r.task as unknown as { source?: string }).source) === 'curated') {
        setLoaded({ state: 'snapshot', detail: r.task as unknown as PackSnapshot })
        return
      }
      // Another wallet's task (or a catalog task) answers the catalog view, without `task`.
      if (!r || !r.task || r.task.kind !== 'user' || !Array.isArray(r.task.versions)) setLoaded({ state: 'missing' })
      else setLoaded({ state: 'ready', detail: r.task })
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) setLoaded({ state: 'missing' })
      else setLoaded((l) => (l.state === 'ready' ? l : { state: 'error', message: describeError(e, 'Could not load the task. Try again.') }))
    }
  }, [id, isNew])

  useEffect(() => {
    setLoaded(isNew ? { state: 'new' } : { state: 'loading' })
    setName(null)
    setDescription(null)
    setTags(null)
    setEditingSource(isNew)
    void reload()
  }, [isNew, reload])

  // Poll every 3 s while the gate runs.
  const validating = detail != null && (detail.status === 'validating' || detail.validation?.status === 'queued' || detail.validation?.status === 'running')
  useEffect(() => {
    if (!validating) return
    const t = window.setInterval(() => void reload(), POLL_MS)
    return () => window.clearInterval(t)
  }, [validating, reload])

  // Layout dry run: the editable pin, or the latest version's pin.
  const latest = detail?.latestVersion ?? null
  const sourceInput: TaskSourceInput | null = editingSource
    ? pin.repo && pin.branch && pin.settled
      ? { repoFullName: pin.repo.fullName, branch: pin.branch, commitSha: pin.commit ?? undefined, path: cleanAgentPath(path), ...(pin.sample ? { source: 'sample' as const } : {}) }
      : null
    : latest
      ? { repoFullName: latest.github.repo, branch: latest.github.branch, commitSha: latest.github.commitSha, path: latest.github.path }
      : null
  const { check, retry } = useTaskLayout(sourceInput)
  const taskFolders = useTaskCandidates(pin, editingSource)
  const read = check.phase === 'done' ? check.data : null
  const contract: TaskContract | null = read?.contract ?? (editingSource ? null : (latest?.contract ?? null))
  const testsVisibility: TestsVisibility | null = read?.pin.testsVisibility ?? (editingSource ? null : (latest?.testsVisibility ?? null))

  // Prefill from task.json (new task) or from the saved task, until the user edits.
  const known = useMemo(() => new Set((tagList ?? []).map((t) => t.id)), [tagList])
  const contractTags = useMemo(
    () => [...(contract?.metadata?.tags?.tools ?? []), ...(contract?.metadata?.tags?.concepts ?? [])].filter((t) => known.has(t)).slice(0, TAGS_MAX),
    [contract, known],
  )
  const nameValue = name ?? detail?.name ?? (contract?.metadata?.title ?? contract?.task.name ?? '').slice(0, NAME_MAX)
  const descValue = description ?? detail?.description ?? (contract?.task.description ?? '').slice(0, DESC_MAX)
  const tagsValue = tags ?? detail?.tags ?? contractTags

  const status: TaskStatus = detail?.status ?? 'draft'
  const lockedAll = validating
  const ready = status === 'ready'
  const sourceOk = editingSource ? read?.layout.ok === true : latest != null
  const identityOk = nameValue.trim().length > 0 && descValue.trim().length > 0 && tagsValue.length > 0
  const canValidate = !lockedAll && identityOk && sourceOk && !(ready && !editingSource)
  const canSave = !lockedAll && nameValue.trim().length > 0 && sourceOk && !busy
  const reason = !nameValue.trim()
    ? 'Add a name to validate.'
    : !descValue.trim()
      ? 'Add a one-line description to validate.'
      : tagsValue.length === 0
        ? 'Pick at least one tag to validate.'
        : !sourceOk
          ? 'Pick a repo folder with a valid task.json to validate.'
          : null

  const toggleTag = (tid: string) => {
    const cur = tagsValue
    setTags(cur.includes(tid) ? cur.filter((t) => t !== tid) : cur.length >= TAGS_MAX ? cur : [...cur, tid])
  }

  const pinChanged =
    editingSource &&
    read != null &&
    latest != null &&
    (read.pin.repoFullName !== latest.github.repo || read.pin.commitSha !== latest.github.commitSha || read.pin.path !== latest.github.path)

  /** Saves metadata and, when the pin changed, a new version. Returns the task id and the latest version number. */
  async function save(): Promise<{ id: string; version: number } | null> {
    setSaveError(null)
    if (isNew) {
      if (!read || !read.layout.ok) return null
      const r = await api.createTask({
        repoFullName: read.pin.repoFullName,
        branch: read.pin.branch,
        commitSha: read.pin.commitSha,
        path: read.pin.path,
        name: nameValue.trim(),
        description: descValue.trim(),
        tags: tagsValue,
        ...(pin.sample ? { source: 'sample' as const } : {}),
      })
      return { id: r.task.id, version: r.version.version }
    }
    if (!detail) return null
    const patch: { name?: string; description?: string; tags?: string[] } = {}
    if (nameValue.trim() !== detail.name) patch.name = nameValue.trim()
    if (descValue.trim() !== detail.description) patch.description = descValue.trim()
    if (!sameSet(tagsValue, detail.tags)) patch.tags = tagsValue
    let current = detail
    if (Object.keys(patch).length > 0) current = (await api.patchTask(detail.id, patch)).task
    let version = current.latestVersion?.version ?? 1
    if (pinChanged && read) {
      const r = await api.createTaskVersion(detail.id, { repoFullName: read.pin.repoFullName, branch: read.pin.branch, commitSha: read.pin.commitSha, path: read.pin.path })
      version = r.version.version
    }
    return { id: detail.id, version }
  }

  async function onSave() {
    setBusy(true)
    try {
      const r = await save()
      if (!r) return
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
      if (isNew) navigate(`/tasks/${encodeURIComponent(r.id)}/edit`, { replace: true })
      else {
        setName(null)
        setDescription(null)
        setTags(null)
        setEditingSource(false)
        await reload()
      }
    } catch (e) {
      setSaveError(errorText(e, 'Could not save the task. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  async function onValidate() {
    if (!canValidate) return
    setBusy(true)
    try {
      const r = await save()
      if (!r) return
      await api.validateTaskVersion(r.id, r.version)
      if (isNew) navigate(`/tasks/${encodeURIComponent(r.id)}/edit`, { replace: true })
      else {
        setName(null)
        setDescription(null)
        setTags(null)
        setEditingSource(false)
        await reload()
      }
    } catch (e) {
      setSaveError(errorText(e, 'Could not start the validation. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  function startNewVersion() {
    if (!latest) return
    pin.setRepo(latest.github.repo)
    pin.setBranch(latest.github.branch)
    setPath(latest.github.path)
    setEditingSource(true)
  }

  // ---- not loaded states
  const crumbs = [{ label: 'Tasks', to: '/tasks?tab=mine' }, { label: isNew ? 'New task' : (detail?.name ?? 'Task') }]
  if (loaded.state === 'snapshot') {
    const snapshot = loaded.detail
    const v = snapshot.latestVersion
    return (
      <main className="tma-page tma-page--flow" data-testid="task-snapshot">
        <Breadcrumb items={[{ label: 'Tasks', to: '/tasks?tab=mine' }, { label: snapshot.name }]} />
        <h1 className="tma-h1">{snapshot.name}</h1>
        <Card className="ta-card">
          <span className="tma-label">Read-only benchmark task</span>
          <p>{snapshot.description}</p>
          {v && <p>Task pack: <code>{v.packId}@{v.packVersion}</code> · version {v.version}</p>}
          <p>The benchmark repository defines this task. Its recorded results keep their original task versions.</p>
          <ButtonLink href="/evaluations" variant="secondary">My evaluations</ButtonLink>
        </Card>
      </main>
    )
  }
  if (loaded.state === 'loading' || loaded.state === 'missing' || loaded.state === 'error') {
    return (
      <main className="tma-page tma-page--flow" data-testid="task-editor">
        <div className="ta-head">
          <Breadcrumb items={crumbs} />
          <h1 className="tma-h1">{loaded.state === 'loading' ? 'Loading task…' : loaded.state === 'missing' ? 'Task not found' : 'Could not load the task'}</h1>
        </div>
        {loaded.state === 'loading' && <div className="ta-skel" aria-busy="true" data-testid="task-loading" style={{ height: 240 }} />}
        {loaded.state === 'missing' && (
          <Card className="ta-card" data-testid="task-missing">
            <span className="ta-help">This task does not exist, or it is not yours.</span>
            <div>
              <ButtonLink variant="secondary" href="/tasks?tab=mine">
                Back to Tasks
              </ButtonLink>
            </div>
          </Card>
        )}
        {loaded.state === 'error' && (
          <Card className="ta-card" data-testid="task-error">
            <span className="ta-error" role="alert">
              {loaded.message}
            </span>
            <div>
              <Button variant="secondary" size={32} onClick={() => void reload()}>
                Try again
              </Button>
            </div>
          </Card>
        )}
      </main>
    )
  }

  const title = isNew ? 'New task' : nameValue || 'Task'
  const sourceBadge =
    check.phase === 'running' ? (
      <Badge tone="warning">Checking</Badge>
    ) : read?.layout.ok || (!editingSource && latest) ? (
      <Badge tone="success" dot>
        Found
      </Badge>
    ) : read && !read.layout.ok ? (
      <Badge tone="danger" dot>
        Missing files
      </Badge>
    ) : (
      <Badge tone="neutral">Not set</Badge>
    )
  const layoutFooter = (
    <>
      {layoutMessage(check)}
      {check.phase === 'error' && (
        <div>
          <Button variant="secondary" size={30} onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      <LayoutTree layout={read?.layout ?? null} contract={contract} />
    </>
  )

  return (
    <main className="tma-page tma-page--flow" data-testid="task-editor">
      <div className="ta-head">
        <Breadcrumb items={crumbs} />
        <div className="ta-head__row">
          <h1 className="tma-h1">{title}</h1>
          {detail && (
            <span className="te-head-meta">
              <Badge tone={GATE_BADGE[status].tone}>{GATE_BADGE[status].label}</Badge>
              {latest && <span className="te-mono te-muted">v{latest.version}</span>}
            </span>
          )}
        </div>
      </div>

      <div className="ta-grid">
        <div className="ta-col">
          <IdentityCard
            name={nameValue}
            setName={(s) => setName(s.slice(0, NAME_MAX))}
            description={descValue}
            setDescription={setDescription}
            tags={tagsValue}
            toggleTag={toggleTag}
            tagList={tagList}
            locked={lockedAll}
          />

          {editingSource ? (
            <GithubPinCard
              gh={pin}
              title={detail ? `Source · new version (v${(latest?.version ?? 0) + 1})` : 'Source · GitHub'}
              badge={sourceBadge}
              pathLabel="Task path"
              path={path}
              onPath={setPath}
              pathOptions={taskFolders.options}
              repoAside={<TestsAside visibility={testsVisibility} />}
              footer={layoutFooter}
              installCopy={INSTALL_COPY}
            />
          ) : (
            detail && (
              <Card className="ta-card" data-testid="source-card">
                <div className="ta-card__top">
                  <span className="tma-label">Source · GitHub</span>
                  {sourceBadge}
                </div>
                <PinSummary detail={detail} onChange={startNewVersion} changeOff={lockedAll || ready} />
                <TestsAside visibility={testsVisibility} />
                {layoutFooter}
              </Card>
            )
          )}
          {editingSource && <SampleRepoNotice gh={pin} kind="task" />}
          {editingSource && detail && (
            <div>
              <button type="button" className="te-link" onClick={() => setEditingSource(false)} data-testid="cancel-new-version">
                Keep v{latest?.version}
              </button>
            </div>
          )}

          <ContractCard contract={contract} shortSha={read?.pin.shortSha ?? latest?.github.shortSha ?? null} />

          <EnvironmentCard contract={contract} locked={lockedAll || (ready && !editingSource)} shortSha={read?.pin.shortSha ?? latest?.github.shortSha ?? null} />

          <ValidationCard detail={detail} canValidate={canValidate} busy={busy} onValidate={onValidate} reason={ready && !editingSource ? null : reason} />

          {detail && detail.versions.length > 0 && <VersionsCard detail={detail} onNewVersion={startNewVersion} newVersionOff={lockedAll || editingSource} />}

          <Card className="ta-card ta-card--tight" data-testid="visibility-card">
            <span className="tma-label">Visibility</span>
            <div role="radiogroup" aria-label="Visibility">
              <RadioCard checked onSelect={() => undefined} title="Private" description="Visible only to you. Results on this task never leave your account." />
            </div>
            <span className="ta-help">Public catalog tasks are curated by testmyagent.</span>
          </Card>

          <div className="ta-actions">
            {saveError && (
              <span className="ta-error" role="alert" data-testid="save-error">
                {saveError}
              </span>
            )}
            <div className="ta-actions__row">
              {saved && (
                <span className="te-saved" role="status" data-testid="saved">
                  Saved
                </span>
              )}
              <Button variant="secondary" onClick={() => navigate('/tasks?tab=mine')}>
                Cancel
              </Button>
              <Button variant="secondary" disabled={!canSave} onClick={onSave} data-testid="save-draft">
                {busy ? 'Saving…' : isNew || status === 'draft' || status === 'invalid' || editingSource ? 'Save draft' : 'Save changes'}
              </Button>
              {ready && !editingSource && detail ? (
                <ButtonLink variant="primary" href={`/agents?tasks=${encodeURIComponent(detail.id)}`} data-testid="rank-agents">
                  Rank agents →
                </ButtonLink>
              ) : (
                <Button variant="primary" disabled={!canValidate || busy} onClick={onValidate} data-testid="validate-task">
                  {validating ? 'Validating…' : 'Validate task'}
                </Button>
              )}
            </div>
            {ready && !editingSource && testsVisibility === 'open' && <span className="ta-help te-right">Open tests: runs on this task are unranked.</span>}
          </div>
        </div>

        <div className="ta-col">
          <Card className="ta-access">
            <div className="tma-card__header">
              <span className="tma-card__title">What we store</span>
            </div>
            <KeyValue
              rows={[
                { key: 'Prompt', value: 'Hashed into the contract' },
                { key: 'Hidden tests', value: 'Read from your repo at the pinned commit. Not copied.' },
                { key: 'Fixture', value: 'Read at the pinned commit. Digest recorded.' },
                { key: 'Shown to vendors', value: 'Outcome and score only' },
              ]}
            />
          </Card>
          <div data-testid="task-json" className="te-json">
            <CodePanel title="task.json in your repo" meta={contract ? (read?.pin.shortSha ?? latest?.github.shortSha ?? '') : 'example'}>
              {JSON.stringify(contract ?? EXAMPLE_CONTRACT, null, 2)}
            </CodePanel>
          </div>
        </div>
      </div>
    </main>
  )
}
