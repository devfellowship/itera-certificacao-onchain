/**
 * S3 Trace view (plan 20261112-tma-c5-studio-area-web2, tasks C5-T6 and UI-S2S3S9). Read only.
 * One session from `tma studio serve` (GET /v1/traces/:session_id[?agent_id=]) through studio/traces.ts: the session
 * summary, the index row, the task summary and candidate info, the first failed step, and a step timeline per run
 * (main first, then subagents by start time). The content never goes to the TMA server (parent ADR-1).
 *
 * Layout from the canvas artboard "S3 Trace view": title, stat tiles, section tabs, the tool-call waterfall (or where
 * the time went) and a side panel with the step that went wrong. A click on a step row opens that step in the panel.
 * Gaps against the artboard (the serve sends no such data): tokens, the Tests / Log / Patch / Grader report tabs,
 * turn rows (the trace has no user turn text), the "Build a case" button (S4 takes no trace yet), and the outcome
 * tile (the merge state of the PR). The profile cannot tell a model pause from a wait on a person, and says so.
 */
import { Fragment, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Card } from '../tma/ui'
import { InfoTip, PinBadge, SignalChips, TaskSummaryBlock, TraceErrorCard, WhyBadge, dash, fmtDuration, fmtTime, useTraceLoad } from './TraceParts'
import { Section, Tab, Tabs, Toggle, ToggleItem, themeClass } from './theme'
import {
  buildProfile,
  buildWaterfall,
  categoryKey,
  categoryLegend,
  CATEGORY_LABEL,
  clockOf,
  fetchTrace,
  fmtMs,
  plainValue,
  stepLabel,
  toolLabel,
  trueSignals,
  type FirstFailure,
  type Trace,
  type TraceRun,
  type TraceSpan,
  type WaterfallRow,
  type WaterfallStep,
} from './traces'
import './studio.css'
import './traces.css'

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

const SHOWN_STEPS = 200

const seqText = (s: TraceSpan) => (s.seq === null ? '—' : String(s.seq).padStart(2, '0'))

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

function Tile({ label, children, field, tone }: { label: string; children: React.ReactNode; field?: string; tone?: 'bad' }) {
  return (
    <div className="trc-tile">
      <span className="stu-label">{label}</span>
      <span className="trc-tile__v" data-field={field}>
        {tone === 'bad' && <span aria-hidden="true" className="trc-dot trc-dot--bad" />}
        {children}
      </span>
    </div>
  )
}

function Stats({ t, retries }: { t: Trace; retries: number }) {
  const s = t.summary
  return (
    <div className="trc-tiles" data-testid="trace-stats">
      <Tile label="tool calls" field="tool_calls">
        {dash(s?.n_tool_calls)}
      </Tile>
      <Tile label="errors" field="errors" tone={(s?.errors ?? 0) > 0 ? 'bad' : undefined}>
        {dash(s?.errors)}
      </Tile>
      <Tile label="retries" field="retries">
        {retries}
      </Tile>
      <Tile label="wall time" field="wall">
        {fmtDuration(s?.duration_s ?? null)}
      </Tile>
      <Tile label="active time" field="active">
        {fmtDuration(s?.active_s ?? null)}
      </Tile>
      <Tile label="runs" field="runs">
        {`${dash(s?.n_runs)}${s?.n_subagent_runs ? ` · ${s.n_subagent_runs} ${s.n_subagent_runs === 1 ? 'subagent' : 'subagents'}` : ''}`}
      </Tile>
      <Tile label="cost" field="cost">
        {s?.cost_usd != null ? `$${s.cost_usd.toFixed(2)}` : '—'}
      </Tile>
    </div>
  )
}

function SummaryTab({ t }: { t: Trace }) {
  const s = t.summary
  const tools = topTools(s?.tool_counts ?? null)
  const c = t.candidate
  return (
    <div className="trc-summary" data-testid="trace-summary-tab">
      {(t.task_summary || c || t.pin) && (
        <Section title="Task" meta={c?.identifier ?? c?.task_id ?? ''} data-testid="trace-candidate">
          {c && (
            <p className="trc-meta">
              <WhyBadge why={c.why} />
              <span data-field="l2_class">{dash(c.l2_class)}</span>
              <span className="stu-label" data-field="mode">
                {dash(c.mode)}
              </span>
              <PinBadge pin={t.pin} />
            </p>
          )}
          {!c && <PinBadge pin={t.pin} />}
          {t.task_summary ? <TaskSummaryBlock summary={t.task_summary} /> : <p className="stu-label">No task summary.</p>}
        </Section>
      )}
      <Section title="Session" meta={t.agent_id ? `agent ${t.agent_id}` : 'session'}>
        <dl className="trc-kv">
          <dt>Session</dt>
          <dd className="stu-label">{t.session_id}</dd>
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
          <dt>Closure</dt>
          <dd>{dash(s?.closure_confidence)}</dd>
          {tools.length > 0 && (
            <>
              <dt>Top tools</dt>
              <dd data-field="tool_counts">{tools.map(([k, v]) => `${k} ${v}`).join(' · ')}</dd>
            </>
          )}
        </dl>
      </Section>
      <Section title="Index" data-testid="trace-index">
        <dl className="trc-kv">
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
      </Section>
    </div>
  )
}

function Axis({ totalMs }: { totalMs: number }) {
  if (totalMs <= 0) return <span className="stu-label">no timestamps</span>
  const ticks = Array.from({ length: 7 }, (_, i) => i / 6)
  return (
    <span className="trc-axis" aria-hidden="true">
      {ticks.map((f, i) => (
        <span key={i} className="trc-axis__tick" style={{ left: `${f * 100}%`, transform: i === 0 ? 'none' : i === 6 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
          {fmtMs(totalMs * f)}
        </span>
      ))}
    </span>
  )
}

function StepLine({ row, on, first, onPick }: { row: WaterfallStep; on: boolean; first: boolean; onPick: () => void }) {
  const s = row.span
  const { label, summary } = stepLabel(s)
  const mark = first ? 'first failure' : row.failed ? 'failure' : ''
  return (
    <div
      role="row"
      className={`trc-wf__row${on ? ' trc-wf__row--on' : ''}${row.failed ? ' trc-wf__row--failed' : ''}`}
      data-trace-step=""
      data-step-ok={row.failed ? 'false' : 'true'}
      data-step-category={row.category}
      data-first-failure-step={first ? '' : undefined}
      onClick={onPick}
    >
      <span role="cell" className="trc-wf__step">
        <button type="button" className="trc-wf__pick" onClick={onPick} aria-pressed={on} aria-label={`Open step ${seqText(s)}`}>
          <span className="trc-wf__n">{seqText(s)}</span>
          <span aria-hidden="true" className={`trc-dot ${row.failed ? 'trc-dot--bad' : 'trc-dot--ok'}`} />
          <span className="trc-wf__tool" title={s.tool ? `${s.tool} · ${CATEGORY_LABEL[row.category]}` : undefined}>
            {label}
          </span>
          <span className="trc-wf__target trc-ellip">{summary}</span>
        </button>
      </span>
      <span role="cell" className="trc-wf__lane">
        {row.left !== null && row.width !== null && (
          <>
            <span className={`trc-bar ${row.failed ? 'trc-bar--err' : `trc-bar--c-${categoryKey(row.category)}`}`} style={{ left: `${row.left}%`, width: `${row.width}%` }} />
            {mark && (
              <span className="trc-wf__mark" style={{ ['--mk' as string]: `${Math.min(row.left + row.width, 88)}%` }}>
                {mark}
              </span>
            )}
          </>
        )}
      </span>
      <span role="cell" className={`trc-wf__time${row.failed ? ' trc-wf__time--bad' : ''}`}>
        {row.failed && <span className="trc-sr">failed, </span>}
        {fmtMs(s.dur_ms)}
      </span>
    </div>
  )
}

function RunLine({ row }: { row: Extract<WaterfallRow, { type: 'run' }> }) {
  const r = row.run
  return (
    <div role="row" className="trc-wf__row trc-wf__row--run" data-testid="trace-run" data-agent-id={r.agent_id ?? ''}>
      <span role="cell" className="trc-wf__step">
        <span aria-hidden="true" className={`trc-dot ${r.is_subagent ? 'trc-dot--warn' : 'trc-dot--merged'}`} />
        <span className="trc-wf__tool">{r.title ?? (r.agent_id ? `Subagent ${r.agent_id}` : 'Main run')}</span>
        <span className="trc-wf__target trc-ellip">
          {r.agent_type ?? (r.is_subagent ? 'subagent' : 'main')}
          {r.models.length ? ` · ${r.models.join(', ')}` : ''}
          {r.description ? ` · ${r.description}` : ''}
        </span>
      </span>
      <span role="cell" className="trc-wf__lane">
        {row.left !== null && row.width !== null && <span className="trc-bar trc-bar--run" style={{ left: `${row.left}%`, width: `${row.width}%` }} />}
      </span>
      <span role="cell" className="trc-wf__time">
        {fmtDuration(r.duration_s)}
      </span>
    </div>
  )
}

function Waterfall({ runs, ffId, sel, onSel }: { runs: TraceRun[]; ffId: string | null; sel: string | null; onSel: (id: string) => void }) {
  const wf = buildWaterfall(runs)
  const [all, setAll] = useState(false)
  let steps = 0
  const shown = all ? wf.rows : wf.rows.filter((r) => r.type === 'run' || ++steps <= SHOWN_STEPS)
  const shownSteps = shown.filter((r) => r.type === 'step').length
  if (wf.rows.length === 0) return <p className="tma-body-sm tma-muted">No runs in this trajectory.</p>
  return (
    <>
      <div className="trc-scroll">
        <div role="table" aria-label="Tool call waterfall" className="trc-wf">
          <div role="row" className="trc-wf__row trc-wf__row--head">
            <span role="columnheader">step</span>
            <span role="columnheader" className="trc-wf__lane">
              <Axis totalMs={wf.totalMs} />
            </span>
            <span role="columnheader" className="trc-wf__time">
              time
            </span>
          </div>
          {shown.map((r) =>
            r.type === 'run' ? <RunLine key={r.id} row={r} /> : <StepLine key={r.id} row={r} on={sel === r.id} first={ffId === r.id} onPick={() => onSel(r.id)} />,
          )}
        </div>
      </div>
      <p className="trc-foot">
        <span className="stu-label" data-testid="trace-shown">
          showing {shownSteps} of {wf.steps} calls
        </span>
        {!all && wf.steps > shownSteps && (
          <button type="button" className="stu-btn stu-btn--secondary" onClick={() => setAll(true)} data-testid="trace-show-all">
            Show all {wf.steps} calls
          </button>
        )}
      </p>
    </>
  )
}

function Profile({ runs, wallS }: { runs: TraceRun[]; wallS: number | null }) {
  const p = buildProfile(runs, wallS)
  const top = p.lines[0]
  return (
    <div className="trc-profile" data-testid="trace-profile">
      {p.wallMs > 0 && top?.key === 'between' && (
        <p className="tma-body-sm">
          Most of the {fmtMs(p.wallMs)} is between calls: the model thinking, or a person answering. The trace does not tell which.
        </p>
      )}
      {p.lines.length === 0 ? (
        <p className="tma-body-sm tma-muted">No timed calls in this trace.</p>
      ) : (
        <div role="table" aria-label="Where time went" className="trc-prof">
          {p.lines.map((l) => (
            <div role="row" key={l.key} className="trc-prof__row">
              <span role="cell" className="trc-prof__label">
                <span aria-hidden="true" className={`trc-swatch trc-bar--${l.key === 'between' ? 'other' : l.key}`} />
                {l.label}
                {l.calls > 0 && <span className="stu-label">{l.calls} {l.calls === 1 ? 'call' : 'calls'}</span>}
              </span>
              <span role="cell" className="trc-prof__bar">
                <span className={`trc-bar trc-bar--${l.key === 'between' ? 'other' : l.key}`} style={{ left: 0, width: `${Math.min(100, l.pct)}%` }} />
              </span>
              <span role="cell" className="trc-wf__time">
                {fmtMs(l.ms)}
              </span>
              <span role="cell" className="trc-prof__pct">
                {l.pct}%
              </span>
            </div>
          ))}
        </div>
      )}
      {p.slowest.length > 0 && (
        <Section title="Slowest calls">
          <ul className="trc-slowest">
            {p.slowest.map((s, i) => (
              <li key={i}>
                <span className="stu-label">{seqText(s)}</span> {dash(toolLabel(s.tool))} · {fmtMs(s.dur_ms)} {s.ok === false && <span className="stu-bad">failed</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

/** The step rows of the Technical details. A row with no value is left out. */
function stepDetailRows(f: FirstFailure): Array<[string, string]> {
  const rows: Array<[string, string | null]> = [
    ['Agent', f.agent_id ?? 'main'],
    ['Step', f.seq === null ? null : String(f.seq)],
    ['Tool', toolLabel(f.tool)],
    ['Intent', f.intent],
    ['Target kind', f.target_kind],
    ['Time', f.ts ? fmtTime(f.ts) : null],
  ]
  return rows.filter((r): r is [string, string] => !!r[1])
}

/** The Barlow "Step 07" heading above a step card. */
function StepHeading({ seq }: { seq: number | null }) {
  return <h2 className="trc-aside__title trc-aside__title--step">Step {seq === null ? '—' : String(seq).padStart(2, '0')}</h2>
}

/** One muted line under the card title: "Bash · test-run · 10:03". */
const stepSummary = (tool: string | null, intent: string | null, ts: string | null) => [toolLabel(tool), intent, clockOf(ts)].filter(Boolean).join(' · ') || '—'

function FirstFailurePanel({ f }: { f: FirstFailure | null }) {
  return (
    <div className="trc-stepblock">
      {f && <StepHeading seq={f.seq} />}
      <section className="trc-panel" data-first-failure="" data-testid="trace-first-failure">
        <span className="trc-panel__head">
          <span aria-hidden="true" className={`trc-dot ${f ? 'trc-dot--bad' : 'trc-dot--ok'}`} />
          {f ? 'Where it went wrong' : 'No failed step'}
        </span>
        {f ? (
          <>
            <p className="stu-label" data-testid="trace-first-failure-line">
              {stepSummary(f.tool, f.intent, f.ts)}
            </p>
            {f.preview && <pre className="trc-preview trc-preview--open">{f.preview}</pre>}
          </>
        ) : (
          <p className="tma-body-sm tma-muted">No failed step.</p>
        )}
      </section>
    </div>
  )
}

function StepPanel({ row }: { row: WaterfallStep }) {
  const s = row.span
  return (
    <div className="trc-stepblock">
      <StepHeading seq={s.seq} />
      <section className="trc-panel" data-testid="trace-step-panel">
        <span className="trc-panel__head">
          <span aria-hidden="true" className={`trc-dot ${row.failed ? 'trc-dot--bad' : 'trc-dot--ok'}`} />
          {row.failed ? 'Failed' : 'Completed'}
          {s.dur_ms !== null && <span className="stu-label trc-panel__meta">{fmtMs(s.dur_ms)}</span>}
        </span>
        <p className="stu-label">{stepSummary(s.tool, s.intent, s.ts)}</p>
        {s.preview ? <Preview key={row.id} text={s.preview} /> : <p className="tma-body-sm tma-muted">No preview stored for this step.</p>}
      </section>
    </div>
  )
}

export function TraceView({ t }: { t: Trace }) {
  const runs = orderRuns(t.runs)
  const wf = buildWaterfall(runs)
  const legend = categoryLegend(runs.flatMap((r) => r.spans))
  const stepRows = wf.rows.filter((r): r is WaterfallStep => r.type === 'step')
  const ff = t.first_failure
  const ffRow = ff ? stepRows.find((r) => r.span.ok === false && (ff.agent_id ?? null) === (runs[r.run]!.agent_id ?? null) && r.span.seq === ff.seq && r.span.ts === ff.ts) ?? null : null
  const ffId = ffRow?.id ?? null
  const [tab, setTab] = useState<'calls' | 'summary'>('calls')
  const [view, setView] = useState<'waterfall' | 'profile'>('waterfall')
  const [sel, setSel] = useState<string | null>(null)
  const selected = sel ? stepRows.find((r) => r.id === sel) ?? null : null
  const retries = runs.reduce((n, r) => n + r.spans.filter((s) => s.retry_of != null).length, 0)
  const s = t.summary
  const signals = trueSignals(t.candidate?.signals ?? null)
  return (
    <div className="trc-view">
      <div className="trc-view__main">
        <div className="trc-view__lead" data-trace-summary="" data-testid="trace-summary">
          <h1 className="tma-h1" data-testid="trace-title">
            {s?.title ?? t.candidate?.identifier ?? 'Trace'}
          </h1>
          <Stats t={t} retries={retries} />
        </div>
        <Tabs label="Run sections" className="trc-tabs">
          <Tab selected={tab === 'summary'} onClick={() => setTab('summary')} data-testid="trace-tab-summary">
            Summary
          </Tab>
          <Tab selected={tab === 'calls'} onClick={() => setTab('calls')} data-testid="trace-tab-calls">
            Tool calls <span className="stu-label">{wf.steps}</span>
          </Tab>
        </Tabs>
        {tab === 'summary' ? (
          <SummaryTab t={t} />
        ) : (
          <section className="trc-calls" data-testid="trace-steps" aria-label="Tool calls">
            <div className="trc-calls__bar">
              <h2 className="trc-calls__title">Tool calls</h2>
              <Toggle label="View" className="trc-views">
                <ToggleItem on={view === 'waterfall'} onClick={() => setView('waterfall')}>
                  Waterfall
                </ToggleItem>
                <ToggleItem on={view === 'profile'} onClick={() => setView('profile')}>
                  Where time went
                </ToggleItem>
              </Toggle>
              <span className="trc-legend" aria-label="Legend" data-testid="trace-legend">
                {legend.map((k) => (
                  <span key={k.category} className="stu-label" data-legend-category={k.category}>
                    <span aria-hidden="true" className={`trc-swatch trc-bar--c-${categoryKey(k.category)}`} />
                    {k.label} <span className="trc-legend__n">{k.calls}</span>
                  </span>
                ))}
                <span className="stu-label" data-legend-category="failed">
                  <span aria-hidden="true" className="trc-swatch trc-bar--err" />
                  failed
                </span>
              </span>
            </div>
            {view === 'waterfall' ? <Waterfall runs={runs} ffId={ffId} sel={sel ?? ffId} onSel={setSel} /> : <Profile runs={runs} wallS={s?.duration_s ?? null} />}
          </section>
        )}
      </div>
      <aside className="trc-aside" aria-label="Trace summary">
        <FirstFailurePanel f={ff} />
        {selected && selected.id !== ffId && <StepPanel row={selected} />}
        <div className="trc-checks">
          {s?.closure_confidence && <span className="stu-label">closure confidence: {s.closure_confidence}</span>}
          {signals.length > 0 && (
            <span className="trc-check">
              Signal: <SignalChips signals={t.candidate?.signals ?? null} />
            </span>
          )}
        </div>
        <details className="trc-details">
          <summary>Technical details</summary>
          <dl className="trc-kv" data-testid="trace-technical">
            {ff &&
              stepDetailRows(ff).map(([k, v]) => (
                <Fragment key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </Fragment>
              ))}
            <dt>Harness</dt>
            <dd>{dash(t.index.harness)}</dd>
            <dt>Host</dt>
            <dd>{dash(t.index.host)}</dd>
            <dt>Extractor</dt>
            <dd className="stu-label">{dash(s?.extractor_version)}</dd>
            <dt>Pin</dt>
            <dd>
              <PinBadge pin={t.pin} />
            </dd>
          </dl>
        </details>
      </aside>
    </div>
  )
}

export function StudioTracePage() {
  const { sessionId = '' } = useParams()
  const [params] = useSearchParams()
  const agentId = params.get('agent_id')
  const loaded = useTraceLoad(() => fetchTrace(sessionId, agentId), [sessionId, agentId])
  const t = loaded.state === 'ok' ? loaded.data : null
  const title = t ? (t.summary?.title ?? t.candidate?.identifier ?? 'Trace') : null
  const useCase = t?.candidate?.l2_class ?? null
  return (
    <main className={themeClass('tma-page', 'trc-page', 'trc-page--view')} data-testid="studio-trace">
      <div className="trc-crumbs">
        <p className="stu-label" data-testid="trace-crumb">
          <Link to="/studio">Studio</Link> / <Link to="/studio/traces" data-testid="trace-back">traces</Link>
          {useCase && (
            <>
              {' / '}
              <Link to={`/studio/traces?l2_class=${encodeURIComponent(useCase)}`}>{plainValue(useCase)}</Link>
            </>
          )}
          {title && (
            <>
              {' / '}
              <span className="trc-crumb__title" data-testid="trace-crumb-title">
                {title}
              </span>
            </>
          )}
        </p>
        <InfoTip label="About this trace" text="One fleet session, step by step. Read only. The content comes from the private trace service, not from the TMA server." />
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
