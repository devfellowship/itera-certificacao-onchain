/**
 * S3 Trace view (plan 20261112-tma-c5-studio-area-web2, task C5-T6). Read only.
 * One session from `tma studio serve` (GET /v1/traces/:session_id[?agent_id=]) through studio/traces.ts: the session
 * summary, the index row, the task summary and candidate info, the first failed step, and a step timeline per run
 * (main first, then subagents by start time). The content never goes to the TMA server (parent ADR-1).
 */
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Card, CardHeader } from '../tma/ui'
import { PinBadge, TaskSummaryBlock, TraceErrorCard, WhyBadge, dash, fmtDuration, fmtTime, useTraceLoad } from './TraceParts'
import { fetchTrace, type FirstFailure, type Trace, type TraceRun, type TraceSpan } from './traces'
import './studio.css'

/** Main run(s) first, then subagents by start time. */
export function orderRuns(runs: readonly TraceRun[]): TraceRun[] {
  const main = runs.filter((r) => !r.is_subagent && r.agent_id === null)
  const rest = runs.filter((r) => !main.includes(r)).sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''))
  return [...main, ...rest]
}

function topTools(counts: Record<string, unknown> | null, n = 8): Array<[string, number]> {
  return Object.entries(counts ?? {})
    .filter((e): e is [string, number] => typeof e[1] === 'number')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
}

function SummaryCard({ t }: { t: Trace }) {
  const s = t.summary
  const tools = topTools(s?.tool_counts ?? null)
  return (
    <Card data-trace-summary="" data-testid="trace-summary">
      <CardHeader title={s?.title ?? 'Session'} meta={t.agent_id ? `agent ${t.agent_id}` : 'session'} />
      <div className="trc-cards stu-pad">
        <dl className="stu-dl trc-dl">
          <dt>Session</dt>
          <dd className="tma-mono">{t.session_id}</dd>
          <dt>Started</dt>
          <dd>{fmtTime(s?.started_at ?? null)}</dd>
          <dt>Ended</dt>
          <dd>{fmtTime(s?.ended_at ?? null)}</dd>
          <dt>Duration</dt>
          <dd>{fmtDuration(s?.duration_s ?? null)}</dd>
          <dt>Active time</dt>
          <dd>{fmtDuration(s?.active_s ?? null)}</dd>
          <dt>Models</dt>
          <dd>{s?.models.length ? s.models.join(', ') : '—'}</dd>
          <dt>Runs</dt>
          <dd data-field="runs">
            {dash(s?.n_runs)} ({dash(s?.n_subagent_runs)} subagent)
          </dd>
          <dt>Tool calls</dt>
          <dd data-field="tool_calls">{dash(s?.n_tool_calls)}</dd>
          <dt>Errors</dt>
          <dd data-field="errors">{dash(s?.errors)}</dd>
          <dt>Closure</dt>
          <dd>{dash(s?.closure_confidence)}</dd>
          <dt>Cost</dt>
          <dd data-field="cost">{s?.cost_usd != null ? `$${s.cost_usd.toFixed(2)}` : '—'}</dd>
          {tools.length > 0 && (
            <>
              <dt>Top tools</dt>
              <dd data-field="tool_counts">{tools.map(([k, v]) => `${k} ${v}`).join(' · ')}</dd>
            </>
          )}
        </dl>
        <dl className="stu-dl trc-dl" data-testid="trace-index">
          <dt>Host</dt>
          <dd>{dash(t.index.host)}</dd>
          <dt>Harness</dt>
          <dd>{dash(t.index.harness)}</dd>
          <dt>Kind</dt>
          <dd>{dash(t.index.kind)}</dd>
          <dt>Messages</dt>
          <dd>{dash(t.index.message_count)}</dd>
          <dt>State</dt>
          <dd>{dash(t.index.state)}</dd>
        </dl>
      </div>
    </Card>
  )
}

function CandidateCard({ t }: { t: Trace }) {
  if (!t.task_summary && !t.candidate && !t.pin) return null
  const c = t.candidate
  return (
    <Card data-testid="trace-candidate">
      <CardHeader title="Task" meta={c?.identifier ?? c?.task_id ?? ''} />
      <div className="stu-pad">
        {c && (
          <p className="trc-row__head trc-small">
            <WhyBadge why={c.why} />
            <span data-field="l2_class">{dash(c.l2_class)}</span>
            <span className="tma-muted" data-field="mode">
              {dash(c.mode)}
            </span>
            <PinBadge pin={t.pin} />
          </p>
        )}
        {!c && <PinBadge pin={t.pin} />}
        {t.task_summary ? <TaskSummaryBlock summary={t.task_summary} /> : <p className="trc-small tma-muted">No task summary.</p>}
      </div>
    </Card>
  )
}

function FirstFailureCard({ f }: { f: FirstFailure | null }) {
  return (
    <Card data-first-failure="" data-testid="trace-first-failure">
      <CardHeader title="First failure" meta={f ? `step ${dash(f.seq)}` : ''} />
      <div className="stu-pad">
        {f ? (
          <>
            <dl className="stu-dl trc-dl">
              <dt>Agent</dt>
              <dd className="tma-mono">{f.agent_id ?? 'main'}</dd>
              <dt>Step</dt>
              <dd>{dash(f.seq)}</dd>
              <dt>Tool</dt>
              <dd>{dash(f.tool)}</dd>
              <dt>Intent</dt>
              <dd>{dash(f.intent)}</dd>
              <dt>Target kind</dt>
              <dd>{dash(f.target_kind)}</dd>
              <dt>Time</dt>
              <dd>{fmtTime(f.ts)}</dd>
            </dl>
            {f.preview && <pre className="trc-preview trc-preview--open">{f.preview}</pre>}
          </>
        ) : (
          <p className="tma-body-sm tma-muted">No failed step.</p>
        )}
      </div>
    </Card>
  )
}

/** A preview clipped to 3 lines with a local "more" toggle. */
function Preview({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.split('\n').length > 3 || text.length > 240
  return (
    <div className="trc-preview-wrap">
      <pre className={open ? 'trc-preview trc-preview--open' : 'trc-preview'} data-testid="step-preview">
        {text}
      </pre>
      {long && (
        <button type="button" className="trc-more" onClick={() => setOpen(!open)} data-testid="step-more">
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

function StepRow({ s, firstFailure }: { s: TraceSpan; firstFailure: boolean }) {
  const ok = s.ok !== false
  return (
    <li
      className={`trc-step${ok ? '' : ' trc-step--failed'}${firstFailure ? ' trc-step--first-fail' : ''}`}
      data-trace-step=""
      data-step-ok={ok ? 'true' : 'false'}
      data-first-failure-step={firstFailure ? '' : undefined}
    >
      <div className="trc-step__head trc-small">
        <span className="tma-mono">#{dash(s.seq)}</span>
        <span className="tma-mono tma-muted">{s.ts ? fmtTime(s.ts).slice(11) : '—'}</span>
        <span className="tma-mono">{dash(s.tool)}</span>
        <span>{[s.shape, s.intent].filter(Boolean).join(' / ') || '—'}</span>
        {s.target_kind && <span className="tma-muted">{s.target_kind}</span>}
        <span className={ok ? 'trc-ok' : 'trc-fail'}>{ok ? 'ok' : 'failed'}</span>
        {s.dur_ms !== null && <span className="tma-muted">{s.dur_ms} ms</span>}
        {firstFailure && <span className="trc-fail">first failure</span>}
      </div>
      {s.preview && <Preview text={s.preview} />}
    </li>
  )
}

function RunSection({ run, ff }: { run: TraceRun; ff: FirstFailure | null }) {
  const isFf = (s: TraceSpan) => !!ff && s.ok === false && (ff.agent_id ?? null) === (run.agent_id ?? null) && s.seq === ff.seq && s.ts === ff.ts
  let marked = false
  return (
    <section className="trc-run" data-testid="trace-run" data-agent-id={run.agent_id ?? ''}>
      <h2 className="stu-subtype">
        {run.title ?? (run.agent_id ? `Subagent ${run.agent_id}` : 'Main run')}{' '}
        <span className="tma-muted trc-small">
          {run.agent_type ?? (run.is_subagent ? 'subagent' : 'main')} · {fmtDuration(run.duration_s)}
          {run.models.length ? ` · ${run.models.join(', ')}` : ''}
        </span>
      </h2>
      {run.description && <p className="tma-body-sm tma-muted">{run.description}</p>}
      {run.spans.length === 0 ? (
        <p className="tma-body-sm tma-muted">No steps.</p>
      ) : (
        <ol className="trc-steps">
          {run.spans.map((s, i) => {
            const mark = !marked && isFf(s)
            if (mark) marked = true
            return <StepRow key={`${s.seq ?? i}:${i}`} s={s} firstFailure={mark} />
          })}
        </ol>
      )}
    </section>
  )
}

export function TraceView({ t }: { t: Trace }) {
  const runs = orderRuns(t.runs)
  return (
    <div className="stu-groups">
      <SummaryCard t={t} />
      <CandidateCard t={t} />
      <FirstFailureCard f={t.first_failure} />
      <Card data-testid="trace-steps">
        <CardHeader title="Steps" meta={`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`} />
        <div className="stu-pad">
          {runs.length === 0 ? <p className="tma-body-sm tma-muted">No runs in this trajectory.</p> : runs.map((r, i) => <RunSection key={`${r.agent_id ?? 'main'}:${i}`} run={r} ff={t.first_failure} />)}
        </div>
      </Card>
    </div>
  )
}

export function StudioTracePage() {
  const { sessionId = '' } = useParams()
  const [params] = useSearchParams()
  const agentId = params.get('agent_id')
  const loaded = useTraceLoad(() => fetchTrace(sessionId, agentId), [sessionId, agentId])
  return (
    <main className="tma-page" data-testid="studio-trace">
      <div className="stu-head">
        <p className="tma-body-sm">
          <Link to="/studio">Studio</Link> / <Link to="/studio/traces" data-testid="trace-back">traces</Link> / <span className="tma-mono">{sessionId.slice(0, 8)}</span>
        </p>
        <h1 className="tma-h1">Trace</h1>
        <p className="stu-sub">One fleet session, step by step. Read only. The content comes from the private trace service, not from the TMA server.</p>
      </div>
      {loaded.state === 'loading' ? (
        <Card pad data-testid="trace-loading">
          <span className="tma-body-sm tma-muted">Loading the trace…</span>
        </Card>
      ) : loaded.state === 'error' ? (
        <TraceErrorCard error={loaded.error} testId="trace-error-card" />
      ) : (
        <TraceView t={loaded.data} />
      )}
    </main>
  )
}
