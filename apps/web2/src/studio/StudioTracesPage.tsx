/**
 * S2 Trace picker (plan 20261112-tma-c5-studio-area-web2, tasks C5-T6 and UI-S2S3S9). Read only.
 * Candidate fleet traces from the daily trace-select output, served by `tma studio serve` (GET /v1/traces) through
 * studio/traces.ts. The content never comes from, and never goes to, the TMA server (parent ADR-1).
 * Filters (URL query): l2_class, why, mode; paging: offset, page size 50. Each row links to S3.
 *
 * Layout from the canvas artboard "S2 Trace picker": a table (date, agent, task, pr / ci, signal, replayable) and a
 * side panel for the focused row (task summary, replay lines, technical details, open the trace). The focused row is
 * the one you click or tab into; the first row is focused at first.
 * Filters (MT-02): one "Filters (n)" button with a dropdown, the active filters as removable chips, "+N more", "Clear
 * all". Rows (MT-04): the task id only, no "picked for" tag (it is a filter and a panel field); the header is the title
 * row only, the selection day moves into its (i).
 * Selection (MT-05, first half): a checkbox column, the "N selected · Clear" bar and a DISABLED "Build N cases" button.
 * Its action (Q 3d291a2b = A: the serve writes case drafts into dfl-evals) lands in its own PR.
 * Gaps against the artboard (the index has no such field or the studio has no such screen): the task title (the row
 * shows the task identifier), the merge state and CI result of the PR, the model size badge, the search box.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Card } from '../tma/ui'
import { useDismiss } from '../tma/ui/useDismiss'
import { AgentAvatar, InfoTip, PinBadge, SignalChips, TaskSummaryBlock, TraceErrorCard, dash, fmtTime, useTraceLoad } from './TraceParts'
import { themeClass } from './theme'
import { TRACE_PAGE_SIZE, agentChip, dayOf, fetchTraceList, newestFirst, plainValue, prUrl, replayOf, shortDay, signalLabel, traceHref, trueSignals, type Replay, type TraceList, type TraceRow } from './traces'
import './studio.css'
import './traces.css'

const FILTERS = ['l2_class', 'why', 'mode'] as const
type FilterKey = (typeof FILTERS)[number]
/** The group labels of the filter bar. The URL parameters keep the field keys. */
const FILTER_LABEL: Record<FilterKey, string> = { l2_class: 'Use case', why: 'Picked for', mode: 'Mode' }

const ABOUT = 'Real agent sessions from the daily selection. A signal (a correction, a re-run, a revert) marks the traces with the most to teach. Read only. The content comes from the private trace service, not from the TMA server.'
const SIGNAL_TIP =
  'A sign that something went wrong or needed help in this session, spotted automatically. correction: a person told the agent it was wrong. re-run: it ran the same thing again. revert: the change was undone later. Traces with a signal teach the most.'

function rowLabel(r: TraceRow): string {
  return r.identifier ?? r.task_id ?? (r.session_id ? r.session_id.slice(0, 8) : '(no id)')
}
const rowKey = (r: TraceRow, i: number) => `${r.session_id ?? ''}:${r.agent_id ?? ''}:${i}`

const REPLAY_TEXT: Record<Replay, string> = { yes: 'yes', partly: 'partly', no: 'no', unpinned: 'not pinned' }
const REPLAY_PATH: Record<Replay, string> = { yes: 'M20 6 9 17l-5-5', partly: 'M5 12h14', no: 'M18 6 6 18M6 6l12 12', unpinned: 'M5 12h14' }

function ReplayCell({ r }: { r: TraceRow }) {
  const v = replayOf(r)
  return (
    <span className={`trc-replay trc-replay--${v}`} data-replay={v}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={REPLAY_PATH[v]} />
      </svg>
      {REPLAY_TEXT[v]}
    </span>
  )
}

/** The pr / ci cell. The index gives the PR link and whether the session ended red; it does not give the merge state. */
function PrCell({ r }: { r: TraceRow }) {
  const pr = prUrl(r.pr)
  const red = r.red === true
  const tone = red ? 'bad' : pr ? 'pr' : 'none'
  const label = red ? 'CI red' : pr ? 'PR linked' : 'no PR'
  return (
    <span className="trc-pr">
      <span aria-hidden="true" className={`trc-dot trc-dot--${tone}`} />
      {pr ? (
        <a href={pr} target="_blank" rel="noreferrer" data-testid="trace-pr" onClick={(e) => e.stopPropagation()}>
          {label}
        </a>
      ) : (
        label
      )}
    </span>
  )
}

function TraceRowLine({ r, on, onFocus, checked, onToggle }: { r: TraceRow; on: boolean; onFocus: () => void; checked: boolean; onToggle: () => void }) {
  const a = agentChip(r)
  const day = dayOf(r.started_at)
  return (
    <div
      role="row"
      className={`trc-row${on ? ' trc-row--on' : ''}`}
      data-trace-row=""
      data-session-id={r.session_id ?? ''}
      data-focused={on ? 'true' : undefined}
      onClick={onFocus}
      onFocus={onFocus}
    >
      <span role="cell" className="trc-cell trc-cell--check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" className="trc-check-box" aria-label={`Select ${rowLabel(r)}`} checked={checked} onChange={onToggle} data-testid="trace-select" />
      </span>
      <span role="cell" className="trc-cell trc-cell--date" title={fmtTime(r.started_at)} data-field="started_at">
        {day ?? '—'}
      </span>
      <span role="cell" className="trc-cell trc-cell--agent" data-field="model">
        <AgentAvatar row={r} />
        <span className="trc-ellip" title={`${a.name} · ${r.model ?? 'model ?'}`}>
          {a.name} · {r.model ?? 'model ?'}
        </span>
      </span>
      <span role="cell" className="trc-cell trc-cell--task">
        <span className="trc-task-line">
          {!r.session_id ? (
            <span className="trc-task-id">{rowLabel(r)}</span>
          ) : r.has_trajectory ? (
            <Link to={traceHref(r.session_id, r.agent_id)} className="trc-task-id" data-testid="trace-link" title={r.session_id}>
              {rowLabel(r)}
            </Link>
          ) : (
            <>
              <span className="trc-task-id" title={r.session_id}>
                {rowLabel(r)}
              </span>
              <span className="trc-none" data-testid="trace-no-file">
                no trajectory file
              </span>
            </>
          )}
        </span>
      </span>
      <span role="cell" className="trc-cell trc-cell--pr">
        <PrCell r={r} />
      </span>
      <span role="cell" className="trc-cell trc-cell--signal">
        <SignalChips signals={r.signals} />
      </span>
      <span role="cell" className="trc-cell trc-cell--replay">
        <ReplayCell r={r} />
      </span>
    </div>
  )
}

function CheckLine({ ok, children }: { ok: boolean; children: string }) {
  return (
    <span className="trc-check">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={ok ? 'var(--stu-ok)' : 'var(--stu-warn)'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {ok ? (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="m8 12 3 3 5-6" />
          </>
        ) : (
          <>
            <path d="M12 3v12" />
            <path d="M12 19h.01" />
          </>
        )}
      </svg>
      {children}
    </span>
  )
}

/** The focused trace: the canvas side panel. */
function FocusPanel({ r }: { r: TraceRow }) {
  const a = agentChip(r)
  const replay = replayOf(r)
  const signals = trueSignals(r.signals)
  const who = [r.executor, r.harness, r.host].filter(Boolean).join(' / ')
  return (
    <aside className="trc-aside trc-aside--picker" aria-label="Focused trace" data-testid="trace-focus">
      <div className="trc-aside__in">
      <div className="trc-aside__head">
        <span className="trc-aside__who">
          <AgentAvatar row={r} />
          <span className="trc-aside__whotext" data-field="who-line">
            {a.name} · {r.model ?? 'model ?'} · <span className="trc-nowrap">{shortDay(r.started_at) ?? '—'}</span>
          </span>
        </span>
        <h2 className="trc-aside__title">{rowLabel(r)}</h2>
      </div>
      <section className="stu-section" aria-label="Task summary">
        <span className="trc-eyebrow">Task summary</span>
        {r.task_summary ? <TaskSummaryBlock summary={r.task_summary} /> : <p className="stu-label">No task summary.</p>}
      </section>
      <div className="trc-checks">
        <CheckLine ok={replay === 'yes'}>
          {replay === 'yes' ? 'Can be replayed exactly' : replay === 'partly' ? 'Can be replayed in part: the pin is incomplete' : replay === 'no' ? 'Cannot be replayed' : 'Not pinned yet: replay needs a pin'}
        </CheckLine>
        {signals.length > 0 && <CheckLine ok={false}>{`Signal: ${signals.map(signalLabel).join(', ')}`}</CheckLine>}
      </div>
      <details className="trc-details">
        <summary>Technical details</summary>
        <dl className="trc-kv">
          <dt>Session</dt>
          <dd className="stu-label">{dash(r.session_id)}</dd>
          <dt>Executor</dt>
          <dd data-field="who">{who || '—'}</dd>
          <dt>Class</dt>
          <dd data-field="l2_class">{dash(r.l2_class && plainValue(r.l2_class))}</dd>
          <dt>Mode</dt>
          <dd data-field="mode">{dash(r.mode && plainValue(r.mode))}</dd>
          <dt>Picked for</dt>
          <dd data-field="why">{dash(r.why && plainValue(r.why))}</dd>
          <dt>Started</dt>
          <dd>{fmtTime(r.started_at)}</dd>
          <dt>Pin</dt>
          <dd>
            <PinBadge pin={r.pin} />
          </dd>
        </dl>
      </details>
      <div className="trc-aside__actions">
        {r.session_id && r.has_trajectory ? (
          <Link to={traceHref(r.session_id, r.agent_id)} className="stu-btn stu-btn--primary" data-testid="trace-open">
            Open the trace
          </Link>
        ) : (
          <span className="stu-label">No trajectory file to open.</span>
        )}
      </div>
      </div>
    </aside>
  )
}

function hrefWith(params: URLSearchParams, change: Record<string, string | null>): string {
  const p = new URLSearchParams(params)
  for (const [k, v] of Object.entries(change)) {
    if (v === null || v === '') p.delete(k)
    else p.set(k, v)
  }
  const s = p.toString()
  return `/studio/traces${s ? `?${s}` : ''}`
}

/** Chips shown before "+N more" (artboard S2: three chips, then "+4 more"). */
const MAX_CHIPS = 3

const FilterIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M7 12h10" />
    <path d="M10 18h4" />
  </svg>
)

/**
 * The S2 filter row (MT-02): one "Filters (n)" button that opens a dropdown with every filter group, the active filters
 * as removable chips ("Use case: fix ×"), "+N more" past three chips, and "Clear all". The state stays in the URL.
 */
function FilterBar({ params, rows }: { params: URLSearchParams; rows: TraceRow[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useDismiss(open, ref, () => setOpen(false), triggerRef)
  const active = FILTERS.flatMap((k) => {
    const v = params.get(k)
    return v ? [{ k, v }] : []
  })
  const shown = active.slice(0, MAX_CHIPS)
  const extra = active.length - shown.length
  return (
    <div className="trc-filters" data-testid="trace-filters">
      <div className="trc-fmenu" ref={ref}>
        <button
          ref={triggerRef}
          type="button"
          className="trc-fbtn"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-testid="trace-filters-button"
        >
          <FilterIcon />
          Filters
          {active.length > 0 && (
            <span className="trc-fbtn__n" data-testid="trace-filters-count">
              {active.length}
            </span>
          )}
        </button>
        {open && (
          <div className="trc-fpanel" role="dialog" aria-label="Filters" data-testid="trace-filters-panel">
            {FILTERS.map((k: FilterKey) => {
              const current = params.get(k)
              const values = [...new Set([...rows.map((r) => r[k]).filter((v): v is string => !!v), ...(current ? [current] : [])])].sort()
              return (
                <div key={k} className="trc-fgroup" data-filter={k} role="group" aria-label={FILTER_LABEL[k]}>
                  <span className="stu-label">{FILTER_LABEL[k]}</span>
                  <div className="trc-fopts">
                    {[null, ...values].map((v) => {
                      const on = (v ?? null) === (current ?? null)
                      return (
                        <Link
                          key={v ?? '(all)'}
                          to={hrefWith(params, { [k]: v, offset: null })}
                          className={`trc-fopt${on ? ' trc-fopt--on' : ''}`}
                          aria-current={on ? 'true' : undefined}
                          data-filter-value={v ?? 'all'}
                          onClick={() => setOpen(false)}
                        >
                          {v === null ? 'all' : plainValue(v)}
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {shown.map(({ k, v }) => (
        <span key={k} className="trc-fchip" data-chip={k}>
          {FILTER_LABEL[k]}: <span className="trc-fchip__v">{plainValue(v)}</span>
          <Link to={hrefWith(params, { [k]: null, offset: null })} className="trc-fchip__x" aria-label={`Remove filter ${FILTER_LABEL[k]}`} data-testid="trace-chip-remove">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </Link>
        </span>
      ))}
      {extra > 0 && (
        <button type="button" className="trc-fmore" onClick={() => setOpen(true)} data-testid="trace-filters-more">
          +{extra} more
        </button>
      )}
      <span className="trc-filters__fill" />
      {active.length > 0 && (
        <Link to={hrefWith(params, { l2_class: null, why: null, mode: null, offset: null })} className="trc-clear" data-testid="trace-clear">
          Clear all
        </Link>
      )}
    </div>
  )
}

function Paging({ params, data }: { params: URLSearchParams; data: TraceList }) {
  const from = data.total === 0 ? 0 : data.offset + 1
  const to = data.offset + data.rows.length
  const prev = data.offset > 0 ? Math.max(0, data.offset - data.limit) : null
  const next = to < data.total ? data.offset + data.limit : null
  return (
    <p className="trc-paging" data-testid="trace-paging">
      {prev !== null && (
        <Link to={hrefWith(params, { offset: prev ? String(prev) : null })} className="stu-btn stu-btn--secondary" data-testid="trace-prev">
          Prev
        </Link>
      )}
      <span className="stu-label" data-testid="trace-count">
        {from}–{to} of {data.total}
      </span>
      {next !== null && (
        <Link to={hrefWith(params, { offset: String(next) })} className="stu-btn stu-btn--secondary" data-testid="trace-next">
          Next
        </Link>
      )}
    </p>
  )
}

type Keyed = Array<{ r: TraceRow; k: string }>

function TraceTable({ rows, focusedKey, onFocus, selected, onSelect }: { rows: Keyed; focusedKey: string | null; onFocus: (k: string) => void; selected: Set<string>; onSelect: (next: Set<string>) => void }) {
  const all = rows.length > 0 && rows.every(({ k }) => selected.has(k))
  const toggle = (k: string) => {
    const next = new Set(selected)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    onSelect(next)
  }
  return (
    <div className="trc-tablewrap">
      <div role="table" aria-label="Traces" className="trc-table">
        <div role="row" className="trc-row trc-row--head">
          <span role="columnheader" className="trc-cell trc-cell--check">
            <input type="checkbox" className="trc-check-box" aria-label="Select all traces on this page" checked={all} onChange={() => onSelect(all ? new Set() : new Set(rows.map(({ k }) => k)))} data-testid="trace-select-all" />
          </span>
          {['date', 'agent', 'task', 'pr / ci', 'signal', 'replayable'].map((h) => (
            <span key={h} role="columnheader" className="trc-cell">
              {h}
              {h === 'signal' && <InfoTip label="About signal" text={SIGNAL_TIP} />}
            </span>
          ))}
        </div>
        {rows.map(({ r, k }) => (
          <TraceRowLine key={k} r={r} on={focusedKey === k} onFocus={() => onFocus(k)} checked={selected.has(k)} onToggle={() => toggle(k)} />
        ))}
      </div>
    </div>
  )
}

export function StudioTracesPage() {
  const [params] = useSearchParams()
  const [focus, setFocus] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const offset = Number(params.get('offset') ?? '0')
  const q = {
    limit: TRACE_PAGE_SIZE,
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
    l2_class: params.get('l2_class'),
    why: params.get('why'),
    mode: params.get('mode'),
  }
  const loaded = useTraceLoad(() => fetchTraceList(q), [q.offset, q.l2_class, q.why, q.mode])
  // A selection belongs to one page of one query: a new page or filter starts empty.
  useEffect(() => setSelected(new Set()), [q.offset, q.l2_class, q.why, q.mode])
  // Newest first on each page. The serve pages by its own order, so the date order holds inside a page only.
  const keyed = loaded.state === 'ok' ? newestFirst(loaded.data.rows).map((r, i) => ({ r, k: rowKey(r, i) })) : []
  const focused = keyed.find((x) => x.k === focus) ?? keyed[0] ?? null
  return (
    <main className={themeClass('tma-page', 'trc-page', 'trc-page--picker')} data-testid="studio-traces">
      <div className="trc-shell">
        <div className="trc-col">
          <div className="trc-head">
            <div className="trc-title">
              <h1 className="tma-h1">Traces</h1>
              <InfoTip
                label="About traces"
                text={loaded.state === 'ok' ? `${ABOUT} Selection day ${loaded.data.source.selection_day}; ${loaded.data.source.pins ? 'pins exist for this day' : 'no pins for this day'}. Newest first on each page.` : ABOUT}
              />
              {loaded.state === 'ok' && (
                <span className="stu-label" data-testid="trace-total">
                  {loaded.data.total} {loaded.data.total === 1 ? 'trace' : 'traces'}
                </span>
              )}
            </div>
          </div>
          {loaded.state === 'loading' ? (
            <Card pad data-testid="traces-loading">
              <span className="tma-body-sm tma-muted">Loading traces…</span>
            </Card>
          ) : loaded.state === 'error' ? (
            <TraceErrorCard error={loaded.error} testId="traces-error" />
          ) : (
            <div data-testid="traces-list" className="trc-list">
              <FilterBar params={params} rows={loaded.data.rows} />
              {selected.size > 0 && (
                <div className="trc-selbar" data-testid="trace-selection">
                  <span className="trc-selbar__n" data-testid="trace-selection-count">
                    {selected.size} selected
                  </span>
                  <button type="button" className="trc-selbar__clear" onClick={() => setSelected(new Set())} data-testid="trace-selection-clear">
                    Clear
                  </button>
                  <span className="trc-filters__fill" />
                  {/* Disabled until the write lands (Q 3d291a2b = A: the serve writes case drafts into dfl-evals). */}
                  <button type="button" className="stu-btn stu-btn--primary" disabled title="Coming next: builds case drafts from the selected traces" data-testid="trace-build-cases">
                    Build {selected.size} {selected.size === 1 ? 'case' : 'cases'}
                  </button>
                </div>
              )}
              {loaded.data.rows.length === 0 ? (
                <p className="tma-body-sm tma-muted" data-testid="traces-empty">
                  No candidate traces match these filters.
                </p>
              ) : (
                <TraceTable rows={keyed} focusedKey={focused?.k ?? null} onFocus={setFocus} selected={selected} onSelect={setSelected} />
              )}
              <Paging params={params} data={loaded.data} />
            </div>
          )}
        </div>
        {focused && <FocusPanel r={focused.r} />}
      </div>
    </main>
  )
}
