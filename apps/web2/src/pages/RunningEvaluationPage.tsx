/**
 * Screen 04 — Running evaluation ("04 Running Evaluation.dc.html"; plan 20261012-itera-testmyagent-ui-refactor, U12).
 * Copy for web2 (plan 20261015-testmyagent-web2-client, UI5): a web2 evaluation ends at `graded`
 * with the score v2 mean. There is no on-chain, manifest, proof or fee stage.
 *
 * Polls GET /evaluations/:id every 3 s (the TypeScript roll-up of U7) until the evaluation ends,
 * and GET /runs/:id per run for the measured model cost (`modelCostUsd`) and the tool-call count.
 * States: queued · running · error (+ graded, cancelled). A run that ends in
 * `infra_error` gets ONE free retry (Gate Q1): the API inserts it; this page shows it.
 * The event log is the API's (derived from timestamps), one line per agent tool call
 * (GET /runs/:id/actions, polled with after_seq), and one live line per active run phase.
 * The runner writes a run's tool calls when its agent phase ends, so the call lines of a run
 * arrive in one batch at that point; the cursor keeps every later poll to the new rows only.
 * L14b (TG 23999 + 24004): at a terminal state the page shows the review layout first (score with its
 * 90% CI, verdict, item navigator, Expected-vs-agent table, Artifacts card; `?item={seq}`), then the
 * Tasks card, then the stage tracker and the event log in a collapsed "Event log". Before the end,
 * the live layout is unchanged.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { HOSTED_RUNS_ENABLED } from '../config'
import type { EvaluationDetail as ApiEvaluationDetail, EvaluationStatus, EvaluationUiState, Run, Task, TaskProfile } from '../lib/api'
import { TaskName, useTaskCatalog } from '../tma/task-filter'
import { AgentAvatar, Breadcrumb, ButtonLink, ModelLabel, SelfDeclaredBadge, SelfDeclaredNote, isSelfDeclared, middle } from '../tma/ui'
import { useSession } from '../auth/session'
import { appendPage, callEvents, EMPTY_FEED, mergeByTime } from './running-evaluation/call-events'
import type { ActionFeed } from './running-evaluation/call-events'
import { EvaluationReview } from './running-evaluation/EvaluationReview'
import { sourceOf, subtitleOf } from './running-evaluation/review'
import './running-evaluation/running-evaluation.css'

const POLL_MS = 3000
const TERMINAL = new Set<string>(['graded', 'issued', 'cancelled', 'failed', 'review'])
const RUN_TERMINAL = new Set(['pass', 'fail', 'invalid', 'timeout', 'infra_error', 'cancelled'])
/** Pages of 200 calls pulled per run per poll, at most: a run with more catches up over the next polls. */
const MAX_PAGES_PER_POLL = 5
const STAGE_NAMES: Record<string, string> = { contract: 'Contract', agent_calls: 'Agent calls', grading: 'Grading' }

const runEnded = (t: { status?: string; stage: string }) => RUN_TERMINAL.has(t.status ?? '') || ['graded', 'timed_out', 'review', 'cancelled'].includes(t.stage)

type Tone = 'ok' | 'live' | 'idle' | 'bad'
/** lib/api types predate the web2 end state: a free evaluation ends at `graded`. */
type Detail = Omit<ApiEvaluationDetail, 'status' | 'uiState'> & { status: EvaluationStatus | 'graded'; uiState: EvaluationUiState | 'graded'; paymentKind?: string; resultOrigin?: string }
type DetailTask = Detail['tasks'][number]

function mmss(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const BADGE: Record<string, { label: string; tone: 'warning' | 'neutral' | 'success' | 'danger' }> = {
  queued: { label: 'Pending', tone: 'warning' },
  running: { label: 'In progress', tone: 'neutral' },
  error: { label: 'Review', tone: 'warning' },
  graded: { label: 'Graded', tone: 'success' },
  issued: { label: 'Graded', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

const TASK_STAGE: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'idle' },
  awaiting_artifact: { label: 'Awaiting artifact', tone: 'live' },
  grading: { label: 'Grading', tone: 'live' },
  graded: { label: 'Graded', tone: 'ok' },
  timed_out: { label: 'Timed out', tone: 'bad' },
  review: { label: 'Review', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'idle' },
}

function taskStage(t: DetailTask): { label: string; tone: Tone } {
  // The API maps phase `preparing` to stage `queued`; a claimed run is "Preparing", not "Queued".
  if (t.stage === 'queued' && t.status === 'running') return { label: 'Preparing', tone: 'live' }
  if (t.stage === 'review' && t.attempts === 1) return { label: 'Retrying', tone: 'live' }
  return TASK_STAGE[t.stage] ?? { label: t.stage, tone: 'idle' }
}

function stageDetail(key: string, state: string, detail: string | null, d: Detail): string {
  if (state === 'wait') {
    if (key === 'agent_calls' || key === 'grading') return d.uiState === 'error' ? 'Blocked' : 'Queued'
    return '—'
  }
  if (key === 'contract' && state === 'active') return `Freezing ${d.taskCount} contract${d.taskCount === 1 ? '' : 's'}`
  if (key === 'grading' && state === 'done' && d.counts) {
    const parts = [d.counts.pass && `${d.counts.pass} PASS`, d.counts.fail && `${d.counts.fail} FAIL`, d.counts.invalid && `${d.counts.invalid} INVALID`].filter(Boolean)
    if (parts.length) return parts.join(' · ')
  }
  return detail ?? '—'
}

function resultBadge(outcome: string | null) {
  if (outcome === 'PASS') return <span className="tma-badge tma-badge--success">PASS</span>
  if (outcome === 'FAIL') return <span className="tma-badge tma-badge--danger">FAIL</span>
  if (outcome === 'INVALID') return <span className="tma-badge tma-badge--neutral">INVALID</span>
  return <span className="re-dash">—</span>
}

function modelText(m: Detail['model']): string {
  return typeof m === 'string' ? m : m.id
}

function downloadPatch(runId: string, patch: string) {
  const url = URL.createObjectURL(new Blob([patch], { type: 'text/x-diff;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${runId}-patch.diff`
  a.click()
  URL.revokeObjectURL(url)
}

function ArtifactResult({ task, run }: { task: DetailTask; run: Run | undefined }) {
  if (!run) return <div className="re-artifact re-artifact--loading" aria-busy="true">Loading stored result…</div>
  const changed = run.patchScope?.changedFiles ?? []
  const hasDetails = Boolean(run.patch || changed.length || run.evidence || run.errors?.length || run.tests)
  return (
    <article className="re-artifact" data-testid="artifact-result" data-run-id={task.runId}>
      <header className="re-artifact__head">
        <div><span className="tma-label">TASK RESULT</span><strong>{task.name}</strong></div>
        <span className="re-mono re-muted">{run.actionsCount ?? 0} actions</span>
      </header>
      {!hasDetails ? <p className="re-muted">This legacy run has no stored artifact.</p> : <>
        <div className="re-artifact__facts">
          <span><b>Result</b>{run.result?.verdict ?? run.status}</span>
          <span><b>Public tests</b>{run.tests?.public ? `${run.tests.public.passed}/${run.tests.public.total}` : '—'}</span>
          <span><b>Hidden tests</b>{run.tests?.hidden ? `${run.tests.hidden.passed}/${run.tests.hidden.total}` : '—'}</span>
          <span><b>Patch scope</b>{run.patchScope ? (run.patchScope.allowed ? 'Allowed' : 'Outside scope') : '—'}</span>
        </div>
        {changed.length > 0 && <div className="re-artifact__files" data-testid="artifact-files"><span className="tma-label">Changed files</span>{changed.map((f) => <code key={f}>{f}</code>)}</div>}
        {run.evidence && <details><summary>Evidence and diagnostics</summary><dl className="re-artifact__evidence"><div><dt>Executor</dt><dd>{run.evidence.executorProfile ?? '—'}</dd></div><div><dt>Environment digest</dt><dd>{run.evidence.environmentDigest ?? '—'}</dd></div><div><dt>Contract digest</dt><dd>{run.evidence.contractDigest ?? '—'}</dd></div></dl>{run.evidence.limitations?.map((x) => <p key={x}>{x}</p>)}</details>}
        {(run.errors?.length ?? 0) > 0 && <details><summary>Errors</summary>{run.errors!.map((x, i) => <pre key={i}>{x}</pre>)}</details>}
        {run.patch && <details className="re-artifact__preview" data-testid="artifact-preview"><summary>Stored patch preview</summary><div className="re-artifact__toolbar"><span>Patch preview reconstructed from the stored run artifact.</span><button type="button" onClick={() => downloadPatch(task.runId, run.patch!)}>Download patch</button></div><pre>{run.patch}</pre></details>}
      </>}
    </article>
  )
}

export function RunningEvaluationPage({ pollMs = POLL_MS }: { pollMs?: number }) {
  const { eid = '' } = useParams()
  const navigate = useNavigate()
  const session = useSession()
  // U36: the model column of the agent card shows the catalog label ("Claude Haiku 4.5"), not the id.
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    api
      .models()
      .then((r) => live && setModelLabels(Object.fromEntries(r.models.map((m) => [m.id, m.label]))))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  const [detail, setDetail] = useState<Detail | null>(null)
  const [fetchedAt, setFetchedAt] = useState(0)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const [cancelling, setCancelling] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const catalogState = useTaskCatalog()
  const taskBy = useMemo(() => {
    const m = new Map<string, Task>()
    if (catalogState.status === 'ready') for (const t of catalogState.catalog.tasks) m.set(t.id, t)
    return m
  }, [catalogState])

  const terminal = detail ? TERMINAL.has(detail.status) : false
  const load = useCallback(async () => {
    try {
      const d = (await api.evaluation(eid)) as Detail
      setDetail(d)
      setFetchedAt(Date.now())
      setError(null)
      return d
    } catch (e) {
      setError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : String(e) })
      return null
    }
  }, [eid])

  // Poll every 3 s until the evaluation ends.
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      const d = await load()
      if (!live) return
      if (!d || !TERMINAL.has(d.status)) timer = setTimeout(tick, pollMs)
    }
    void tick()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [load, pollMs])

  // Per-run detail: cost and tool calls. A finished run is read once; an active run on every poll.
  const runsRef = useRef(runs)
  runsRef.current = runs
  useEffect(() => {
    if (!detail) return
    for (const t of detail.tasks) {
      const known = runsRef.current[t.runId]
      if (known && RUN_TERMINAL.has(known.status) && known.modelCostUsd != null) continue
      if (t.stage === 'queued' && t.status !== 'running') continue
      api
        .run(t.runId)
        .then((r) => setRuns((m) => ({ ...m, [t.runId]: r })))
        .catch(() => undefined)
    }
  }, [detail])

  // L14b: the task rules (limits, editable paths, instruction) of each task, once, at the end. A private
  // task answers 404: the rows that need it are omitted.
  const [profiles, setProfiles] = useState<Record<string, TaskProfile | null>>({})
  const profilesRef = useRef(profiles)
  profilesRef.current = profiles
  const loadingProfiles = useRef(new Set<string>())
  useEffect(() => {
    if (!detail || !TERMINAL.has(detail.status)) return
    for (const t of detail.tasks) {
      if (t.slug in profilesRef.current || loadingProfiles.current.has(t.slug)) continue
      loadingProfiles.current.add(t.slug)
      api
        .publicTask(t.slug)
        .then((p) => setProfiles((m) => ({ ...m, [t.slug]: p })))
        .catch(() => setProfiles((m) => ({ ...m, [t.slug]: null })))
        .finally(() => loadingProfiles.current.delete(t.slug))
    }
  }, [detail])

  // Tool calls per run: GET /runs/:id/actions?after_seq=<cursor> on every poll. A finished run is read
  // until its last page, then never again.
  const [feeds, setFeeds] = useState<Record<string, ActionFeed>>({})
  const feedsRef = useRef(feeds)
  feedsRef.current = feeds
  const pulling = useRef(new Set<string>())
  const detailRef = useRef(detail)
  detailRef.current = detail
  const [pullTick, setPullTick] = useState(0)
  useEffect(() => {
    if (!detail || isSelfDeclared(detail)) return // L11: a self-declared run has no actions (Q4 = C).
    for (const t of detail.tasks) {
      const runId = t.runId
      const ended = runEnded(t)
      if (t.stage === 'queued' && t.status !== 'running' && !ended) continue
      if (feedsRef.current[runId]?.done || pulling.current.has(runId)) continue
      pulling.current.add(runId)
      void (async () => {
        try {
          let feed = feedsRef.current[runId] ?? EMPTY_FEED
          for (let i = 0; i < MAX_PAGES_PER_POLL; i++) {
            const page = await api.runActions(runId, feed.after)
            feed = appendPage(feed, page, ended)
            if (!page.hasMore) break
          }
          setFeeds((m) => ({ ...m, [runId]: feed }))
        } catch {
          // The log is decoration: a failed poll leaves the lines as they were and the next poll retries.
        } finally {
          pulling.current.delete(runId)
          // The run ended while this pull was in flight, and polling may have stopped: pull once more for the last rows.
          const now = detailRef.current?.tasks.find((x) => x.runId === runId)
          if (!ended && now && runEnded(now)) setPullTick((n) => n + 1)
        }
      })()
    }
  }, [detail, pullTick])

  // The log keeps its newest line in view while the reader stays at the bottom.
  const logRef = useRef<HTMLDivElement | null>(null)
  const stickToEnd = useRef(true)
  const lineCount = detail ? detail.events.length + Object.values(feeds).reduce((a, f) => a + f.rows.length, 0) : 0
  useLayoutEffect(() => {
    const el = logRef.current
    if (el && stickToEnd.current) el.scrollTop = el.scrollHeight
  }, [lineCount])

  // Elapsed timer between polls.
  useEffect(() => {
    if (terminal) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [terminal])

  if (error && !detail) {
    return (
      <main className="tma-page tma-page--flow re-page" data-testid="running-evaluation-page">
        <Breadcrumb items={[{ label: 'My evaluations', to: '/evaluations' }, { label: 'Evaluation' }]} />
        <h1 className="tma-h1">Evaluation</h1>
        <div className="re-card re-empty" role="alert" data-testid="evaluation-error">
          {error.status === 404 ? 'Evaluation not found. It belongs to another account, or the link is wrong.' : `Could not load the evaluation: ${error.message}`}
          <Link to="/evaluations">Back to My evaluations</Link>
        </div>
      </main>
    )
  }
  if (!detail) {
    return (
      <main className="tma-page tma-page--flow re-page" data-testid="running-evaluation-page" aria-busy="true">
        <Breadcrumb items={[{ label: 'My evaluations', to: '/evaluations' }, { label: 'Evaluation' }]} />
        <h1 className="tma-h1">Evaluation</h1>
        <div className="re-card re-stages re-skeleton" />
      </main>
    )
  }

  const d = detail
  const ui = d.uiState
  const badge = BADGE[ui] ?? BADGE.running
  const elapsed = terminal ? d.elapsedMs : d.elapsedMs + Math.max(0, now - fetchedAt)
  const graded = d.tasks.filter((t) => t.stage === 'graded' || t.stage === 'timed_out').length
  const shownStages = d.stages.filter((s) => s.key in STAGE_NAMES)
  const commit = d.agent.commit ? d.agent.commit.slice(0, 7) : null
  const agentLink = d.agent.id ? `/agents/${d.agent.id}` : '/agents'
  // U36 (TG 21092): agent card under the title — AgentAvatar, author, model, source, tasks · fee.
  const mine = !!session.wallet && d.agent.authorWallet === session.wallet
  const authorName = mine ? 'you' : d.agent.authorProfile?.displayName ?? (d.agent.authorProfile?.username ? `@${d.agent.authorProfile.username}` : d.agent.authorWallet ? middle(d.agent.authorWallet, 4, 4) : null)
  const modelLabel = typeof d.model === 'string' ? d.model : (modelLabels[d.model.id] ?? d.model.id)
  const repoShort = d.agent.repo ? d.agent.repo.split('/').pop() : null
  // L11 (0021): a result the owner uploaded with `tma upload`. TMA did not run, grade or attest it; no actions, no artifact.
  const selfDeclared = isSelfDeclared(d)

  // Error banner: a timed-out run (INVALID) or a platform fault after the free retry.
  const timedOut = d.tasks.find((t) => t.stage === 'timed_out')
  const fault = d.tasks.find((t) => t.stage === 'review' && (t.attempts ?? 1) > 1)
  const retrying = d.tasks.find((t) => t.stage === 'review' && (t.attempts ?? 1) === 1)

  // Event log: the API's events + one live line for each active run phase.
  const t0 = d.createdAt && Number.isFinite(Date.parse(d.createdAt)) ? Date.parse(d.createdAt) : fetchedAt - d.elapsedMs
  const calls = callEvents(
    d.tasks.map((t) => ({ slug: t.slug, rows: feeds[t.runId]?.rows ?? [] })),
    t0,
  )
  const events: Array<{ tMs: number; tone: Tone; label: string; detail: string | null }> = mergeByTime<{ tMs: number; tone: Tone; label: string; detail: string | null }>([...d.events], calls)
  if (!terminal) {
    for (const t of d.tasks) {
      const r = runs[t.runId]
      if (t.status !== 'running') continue
      const n = r?.actionsCount != null ? ` · ${r.actionsCount} tool call${r.actionsCount === 1 ? '' : 's'}` : ''
      if (t.phase === 'preparing') events.push({ tMs: elapsed, tone: 'live', label: 'Preparing sandbox', detail: t.slug })
      else if (t.phase === 'agent_running') events.push({ tMs: elapsed, tone: 'live', label: 'Agent running', detail: `${t.slug}${n}` })
      else if (t.phase === 'grading') events.push({ tMs: elapsed, tone: 'live', label: 'Grading', detail: `${t.slug}${n}` })
    }
    if (ui === 'error' && !dismissed) events.push({ tMs: elapsed, tone: 'live', label: 'Waiting on you', detail: 'retry or continue' })
  }

  const onCancel = async () => {
    if (cancelling) return
    if (!window.confirm('Cancel this evaluation? Queued tasks stop. Running tasks finish.')) return
    setCancelling(true)
    try {
      await api.cancelEvaluation(d.id)
      navigate('/evaluations')
    } catch (e) {
      setError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : String(e) })
      setCancelling(false)
    }
  }

  const totalCost = Object.values(runs).reduce((a, r) => a + (r.modelCostUsd ?? 0), 0)
  // L14b: at the end the title is the agent, the subtitle names the tasks, the source and the score version.
  const source = sourceOf(d)
  const firstRun = d.tasks[0] ? runs[d.tasks[0].runId] : undefined
  // L15b: no Re-run while web2 = ingested only (Tainan TG 23889); the API would refuse the start.
  const rerunHref = HOSTED_RUNS_ENABLED && terminal && source === 'run here' && d.agent.id ? `/agents/${encodeURIComponent(d.agent.id)}/evaluate` : null

  // The live layout pieces, placed by both layouts (L14b).
  const stageTracker = (
    <div className="re-card re-stages" data-testid="stage-tracker">
      {shownStages.map((s, i) => (
        <div key={s.key} className={`re-stage re-stage--${s.state}`} data-testid={`stage-${s.key}`} data-state={s.state}>
          <div className="re-stage__top">
            <span className="re-stage__circle">{s.state === 'done' ? '✓' : s.state === 'active' ? '•' : s.state === 'error' ? '!' : ''}</span>
            <span className="re-stage__line" style={i === shownStages.length - 1 ? { background: 'transparent' } : undefined} />
          </div>
          <div className="re-stage__text">
            <span className="re-stage__name">{STAGE_NAMES[s.key] ?? s.key}</span>
            <span className="re-mono re-muted">{stageDetail(s.key, s.state, s.detail, d)}</span>
          </div>
        </div>
      ))}
    </div>
  )
  const tasksCard = (
    <div className="re-card">
      <div className="re-card__head">
        <span className="re-card__title">Tasks</span>
        <span className="re-mono re-muted">
          {graded} of {d.taskCount} graded
        </span>
      </div>
      <div className="re-row re-row--head">
        <span>Task</span>
        <span>Stage</span>
        <span className="re-r">Tests</span>
        <span className="re-r">Time</span>
        <span className="re-r">Result</span>
      </div>
      {d.tasks.map((t) => {
        const st = taskStage(t)
        const total = t.testsTotal ?? taskBy.get(t.taskId)?.hiddenTestsCount ?? null
        const cost = runs[t.runId]?.modelCostUsd
        return (
          <div key={t.runId} className="re-row" data-testid="run-row" data-run-id={t.runId} data-stage={t.stage}>
            <div className="re-row__task">
              <TaskName className="re-row__name" name={t.name} taskId={t.taskId} slug={t.slug} />
              <span className="re-mono re-subtle">
                {t.slug}
                {cost != null && <span data-testid="run-cost"> · model ${cost.toFixed(3)}</span>}
                {(t.attempts ?? 1) > 1 && ' · retry'}
              </span>
            </div>
            <span className={`re-stage-cell re-tone--${st.tone}`}>
              <span className="re-dot" />
              {st.label}
            </span>
            <span className="re-r re-mono re-num">
              {t.testsPassed ?? '—'} / {total ?? '—'}
            </span>
            <span className="re-r re-mono re-muted re-num">{mmss(t.durationMs)}</span>
            <span className="re-result">
              {resultBadge(t.outcome)}
              <span className="re-mono re-num" data-testid="run-score">
                {t.score != null ? t.score : '—'}
              </span>
            </span>
          </div>
        )
      })}
      {totalCost > 0 && (
        <div className="re-cost" data-testid="total-model-cost">
          <span className="tma-label">Model cost</span>
          <span className="re-mono">
            ${totalCost.toFixed(3)} · paid with your OpenRouter key · <ModelLabel model={modelText(d.model)} label={modelText(d.model)} size={16} />
          </span>
        </div>
      )}
    </div>
  )
  // L11: a self-declared result has no actions, so no event log card (Q4 = C).
  const logCard = selfDeclared ? null : (
    <div className="re-card re-card--log">
      <div className="re-card__head re-card__head--log">
        <span className="tma-label">Event log</span>
        <span className="re-mono re-subtle">UTC</span>
      </div>
      <div
        className="re-events"
        ref={logRef}
        data-testid="event-log"
        onScroll={(ev) => {
          const el = ev.currentTarget
          stickToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {events.map((e, i) => (
          <div key={i} className="re-event" data-testid="event-row">
            <span className="re-subtle re-num">{mmss(e.tMs)}</span>
            <span className={`re-dot re-dot--${e.tone}`} />
            <span className="re-event__text">
              <span>{e.label}</span> <span className="re-muted">{e.detail}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <main className="tma-page tma-page--flow re-page" data-testid="running-evaluation-page" data-ui-state={ui} data-origin={d.resultOrigin ?? 'hosted'}>
      <div className="re-head">
        <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: d.agent.name, to: agentLink }, { label: 'Evaluation' }]} />
        <div className="re-head__row">
          <div className="re-head__titles">
            <div className="re-head__title">
              <h1 className="tma-h1" data-testid="evaluation-title">{terminal ? d.agent.name : 'Evaluation'}</h1>
              <span className={`tma-badge tma-badge--${badge.tone} re-badge--${ui}`} data-testid="evaluation-status" data-status={d.status}>
                <span className="tma-badge__dot" />
                {badge.label}
              </span>
              {selfDeclared && <SelfDeclaredBadge testId="evaluation-self-declared" />}
            </div>
            <span className="re-mono re-muted" data-testid="evaluation-meta">
              {terminal ? subtitleOf(d, firstRun) : <>{d.shortId.startsWith('ev_') ? d.shortId : `ev_${d.shortId}`} · {d.agent.name} {commit} · {d.taskCount} task{d.taskCount === 1 ? '' : 's'}</>}
            </span>
          </div>
          <div className="re-head__right">
            <div className="re-elapsed">
              <span className="tma-label">Elapsed</span>
              <span className="re-elapsed__v" data-testid="elapsed">
                {mmss(elapsed)}
              </span>
            </div>
            {terminal ? (
              <div className="re-head__links">
                <Link to={agentLink} className="re-head__link" data-testid="view-agent">
                  View agent
                </Link>
                <Link to="/evaluations" className="re-head__link">
                  My evaluations
                </Link>
                {rerunHref && (
                  <ButtonLink variant="primary" href={rerunHref} data-testid="rerun">
                    Re-run
                  </ButtonLink>
                )}
              </div>
            ) : (
              <button type="button" className="re-btn" onClick={onCancel} disabled={cancelling} data-testid="cancel-evaluation">
                {cancelling ? 'Cancelling…' : 'Cancel evaluation'}
              </button>
            )}
          </div>
        </div>
      </div>

      <section className="re-agent" data-testid="evaluation-agent-card">
        <div className="re-agent__id">
          <AgentAvatar size={44} id={d.agent.id} name={d.agent.name} src={d.agent.avatarUrl} author={authorName ? { name: authorName === 'you' ? session.me?.displayName ?? d.agent.authorProfile?.displayName ?? 'you' : authorName, avatarUrl: d.agent.authorProfile?.avatarUrl ?? (mine ? session.me?.avatarUrl : null) } : null} />
          <div className="re-agent__text">
            <span className="re-agent__name">{d.agent.name}</span>
            {authorName && (
              <span className="re-agent__by">
                by <b>{authorName}</b>
              </span>
            )}
          </div>
        </div>
        <div className="re-agent__kv">
          <span className="tma-label">Model</span>
          <span className="re-agent__v">
            <ModelLabel model={modelText(d.model)} label={modelLabel} size={20} />
          </span>
        </div>
        {repoShort && (
          <div className="re-agent__kv">
            <span className="tma-label">Source</span>
            <span className="re-agent__v re-mono">
              {repoShort}
              {commit ? `@${commit}` : ''}
            </span>
          </div>
        )}
        <div className="re-agent__kv">
          <span className="tma-label">Tasks</span>
          <span className="re-agent__v re-mono">{d.taskCount}</span>
        </div>
        <Link to={agentLink} className="re-agent__link">
          View agent →
        </Link>
      </section>

      {ui === 'error' && !dismissed && (timedOut || fault) && (
        <div className="re-banner" role="alert" data-testid="error-banner">
          <div className="re-banner__text">
            {timedOut ? (
              <>
                <span className="re-banner__title">Agent timed out on “{timedOut.name}”.</span>
                <span className="re-banner__body">No artifact within the time limit. The task is INVALID, not FAIL. Other tasks are unaffected.</span>
              </>
            ) : (
              <>
                <span className="re-banner__title">Platform fault on “{fault!.name}”, twice.</span>
                <span className="re-banner__body">The free retry also failed. The task is marked Review, never FAIL. Other tasks are unaffected.</span>
              </>
            )}
          </div>
          <div className="re-banner__actions">
            <button type="button" className="re-btn re-btn--h32" onClick={() => setDismissed(true)}>
              Continue without it
            </button>
            <button type="button" className="re-btn re-btn--h32 re-btn--inverse" disabled title="Retry is not available yet">
              Retry task
            </button>
          </div>
        </div>
      )}
      {retrying && (
        <div className="re-note" data-testid="free-retry">
          Platform fault on “{retrying.name}”. A free retry is queued. No charge.
        </div>
      )}
      {selfDeclared && <SelfDeclaredNote />}
      {d.status === 'graded' && (
        <div className="re-note re-note--ok" data-testid="graded-banner">
          <span>
            Graded · mean score <b className="re-mono" data-testid="score-total">{d.score != null ? d.score : '—'}</b>
          </span>
        </div>
      )}

      {terminal && <EvaluationReview detail={d} runs={runs} profiles={profiles} />}

      {terminal && tasksCard}
      {terminal ? (
        <details className="re-card re-live" data-testid="live-details">
          <summary className="re-live__summary">Event log</summary>
          <div className="re-live__body">
            {stageTracker}
            {logCard}
          </div>
        </details>
      ) : (
        <>
          {stageTracker}
          <div className="re-grid">
            {tasksCard}
            {logCard}
          </div>
        </>
      )}

      {terminal && !selfDeclared && (
        <section className="re-artifacts" data-testid="artifacts-results">
          <div className="re-card__head"><div><span className="tma-label">ARTIFACTS AND RESULTS</span><h2 className="tma-h2">Stored run evidence</h2></div><span className="re-mono re-muted">Owner access</span></div>
          {d.tasks.map((t) => <ArtifactResult key={t.runId} task={t} run={runs[t.runId]} />)}
        </section>
      )}
    </main>
  )
}
