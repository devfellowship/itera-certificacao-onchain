/**
 * Screen 04 — Running evaluation ("04 Running Evaluation.dc.html"; plan 20261012-itera-testmyagent-ui-refactor, U12).
 *
 * Polls GET /evaluations/:id every 3 s (the TypeScript roll-up of U7) until the evaluation ends,
 * and GET /runs/:id per run for the measured model cost (`modelCostUsd`) and the tool-call count.
 * States: queued · running · issuing · error (+ issued, cancelled). A run that ends in
 * `infra_error` gets ONE free retry (Gate Q1): the API inserts it; this page shows it.
 * The event log is the API's (derived from timestamps), one line per agent tool call
 * (GET /runs/:id/actions, polled with after_seq), and one live line per active run phase.
 * The runner writes a run's tool calls when its agent phase ends, so the call lines of a run
 * arrive in one batch at that point; the cursor keeps every later poll to the new rows only.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, explorerTxUrl } from '../lib/api'
import type { EvaluationDetail, Run, Task } from '../lib/api'
import { TaskName, useTaskCatalog } from '../tma/task-filter'
import { AgentAvatar, Breadcrumb, ButtonLink, formatSol, ModelLabel, middle } from '../tma/ui'
import { useSession } from '../auth/session'
import { appendPage, callEvents, EMPTY_FEED, mergeByTime } from './running-evaluation/call-events'
import type { ActionFeed } from './running-evaluation/call-events'
import './running-evaluation/running-evaluation.css'

const POLL_MS = 3000
const TERMINAL = new Set(['issued', 'cancelled', 'failed'])
const RUN_TERMINAL = new Set(['pass', 'fail', 'invalid', 'timeout', 'infra_error', 'cancelled'])
/** Pages of 200 calls pulled per run per poll, at most: a run with more catches up over the next polls. */
const MAX_PAGES_PER_POLL = 5
const STAGE_NAMES: Record<string, string> = { contract: 'Contract', agent_calls: 'Agent calls', grading: 'Grading', manifest: 'Manifest', attestation: 'Attestation' }

const runEnded = (t: { status?: string; stage: string }) => RUN_TERMINAL.has(t.status ?? '') || ['graded', 'timed_out', 'review', 'cancelled'].includes(t.stage)

type Tone = 'ok' | 'live' | 'idle' | 'bad'
type Detail = EvaluationDetail
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
  issuing: { label: 'Pending', tone: 'warning' },
  error: { label: 'Review', tone: 'warning' },
  issued: { label: 'Issued', tone: 'success' },
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
  if (key === 'manifest' && d.manifestSha256) return `sha256 ${middle(d.manifestSha256, 4, 4)}`
  if (key === 'grading' && state === 'done' && d.counts) {
    const parts = [d.counts.pass && `${d.counts.pass} PASS`, d.counts.fail && `${d.counts.fail} FAIL`, d.counts.invalid && `${d.counts.invalid} INVALID`].filter(Boolean)
    if (parts.length) return parts.join(' · ')
  }
  if (key === 'attestation' && state === 'active') return 'Awaiting confirmation'
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

export function RunningEvaluationPage() {
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
      const d = await api.evaluation(eid)
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
      if (!d || !TERMINAL.has(d.status)) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [load])

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
    if (!detail) return
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
          {error.status === 404 ? 'Evaluation not found. It belongs to another wallet, or the link is wrong.' : `Could not load the evaluation: ${error.message}`}
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
  const commit = d.agent.commit ? d.agent.commit.slice(0, 7) : null
  const agentLink = d.agent.id ? `/agents/${d.agent.id}` : '/agents'
  // U36 (TG 21092): agent card under the title — AgentAvatar, author, model, source, tasks · fee.
  const mine = !!session.wallet && d.agent.authorWallet === session.wallet
  const authorName = mine ? 'you' : d.agent.authorProfile?.displayName ?? (d.agent.authorProfile?.username ? `@${d.agent.authorProfile.username}` : d.agent.authorWallet ? middle(d.agent.authorWallet, 4, 4) : null)
  const modelLabel = typeof d.model === 'string' ? d.model : (modelLabels[d.model.id] ?? d.model.id)
  const repoShort = d.agent.repo ? d.agent.repo.split('/').pop() : null

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
    if (!window.confirm('Cancel this evaluation? Queued tasks stop. Running tasks finish. The fee is not refunded.')) return
    setCancelling(true)
    try {
      await api.cancelEvaluation(d.id)
      navigate('/evaluations')
    } catch (e) {
      setError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : String(e) })
      setCancelling(false)
    }
  }

  const profileUrl = d.slug && d.isPublic ? `/e/${d.slug}` : null
  const totalCost = Object.values(runs).reduce((a, r) => a + (r.modelCostUsd ?? 0), 0)

  return (
    <main className="tma-page tma-page--flow re-page" data-testid="running-evaluation-page" data-ui-state={ui}>
      <div className="re-head">
        <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: d.agent.name, to: agentLink }, { label: 'Evaluation' }]} />
        <div className="re-head__row">
          <div className="re-head__titles">
            <div className="re-head__title">
              <h1 className="tma-h1">Evaluation</h1>
              <span className={`tma-badge tma-badge--${badge.tone} re-badge--${ui}`} data-testid="evaluation-status">
                <span className="tma-badge__dot" />
                {badge.label}
              </span>
            </div>
            <span className="re-mono re-muted" data-testid="evaluation-meta">
              {d.shortId.startsWith('ev_') ? d.shortId : `ev_${d.shortId}`} · {d.agent.name} {commit} · {d.taskCount} task{d.taskCount === 1 ? '' : 's'}
            </span>
          </div>
          <div className="re-head__right">
            <div className="re-elapsed">
              <span className="tma-label">Elapsed</span>
              <span className="re-elapsed__v" data-testid="elapsed">
                {mmss(elapsed)}
              </span>
            </div>
            {ui === 'issued' && profileUrl ? (
              <ButtonLink variant="primary" href={profileUrl} data-testid="view-profile">
                View public profile
              </ButtonLink>
            ) : terminal ? (
              <ButtonLink variant="secondary" href="/evaluations">
                My evaluations
              </ButtonLink>
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
          <span className="tma-label">Tasks · Fee</span>
          <span className="re-agent__v re-mono">
            {d.taskCount}
            {d.fee ? ` · ${formatSol(d.fee.lamports, { fromLamports: true, decimals: 3 })} SOL` : ''}
          </span>
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
            <button type="button" className="re-btn re-btn--h32 re-btn--inverse" disabled title="Retry arrives after the hackathon">
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
      {ui === 'issued' && (
        <div className="re-note re-note--ok" data-testid="issued-banner">
          <span>
            Evidence issued: {d.proofs.filter((p) => p.status === 'confirmed').length} proof{d.proofs.length === 1 ? '' : 's'} confirmed on Solana devnet
            {d.score != null ? ` · score ${d.score}` : ''}.
          </span>
          <span className="re-note__links">
            {d.proofs.map((p) =>
              p.txSig ? (
                <a key={p.runId} href={explorerTxUrl(p.txSig)} target="_blank" rel="noreferrer" className="re-mono">
                  tx {middle(p.txSig, 4, 4)}
                </a>
              ) : null,
            )}
            {profileUrl && <Link to={profileUrl}>Public profile →</Link>}
          </span>
        </div>
      )}

      <div className="re-card re-stages" data-testid="stage-tracker">
        {d.stages.map((s, i) => (
          <div key={s.key} className={`re-stage re-stage--${s.state}`} data-testid={`stage-${s.key}`} data-state={s.state}>
            <div className="re-stage__top">
              <span className="re-stage__circle">{s.state === 'done' ? '✓' : s.state === 'active' ? '•' : s.state === 'error' ? '!' : ''}</span>
              <span className="re-stage__line" style={i === d.stages.length - 1 ? { background: 'transparent' } : undefined} />
            </div>
            <div className="re-stage__text">
              <span className="re-stage__name">{STAGE_NAMES[s.key] ?? s.key}</span>
              <span className="re-mono re-muted">{stageDetail(s.key, s.state, s.detail, d)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="re-grid">
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
              <div key={t.runId} className="re-row" data-testid="task-row" data-run-id={t.runId} data-stage={t.stage}>
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
                <span className="re-result">{resultBadge(t.outcome)}</span>
              </div>
            )
          })}
          {totalCost > 0 && (
            <div className="re-cost" data-testid="total-model-cost">
              <span className="tma-label">Model cost</span>
              <span className="re-mono">
                ${totalCost.toFixed(3)} · paid by TestMyAgent · <ModelLabel model={modelText(d.model)} label={modelText(d.model)} size={16} />
              </span>
            </div>
          )}
        </div>

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
      </div>
    </main>
  )
}
