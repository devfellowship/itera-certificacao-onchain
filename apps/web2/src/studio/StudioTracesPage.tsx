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
 * Selection (MT-05): a checkbox column, the "N selected · Clear" bar, a use case (one of the 33 L1 pairs) and
 * "Build N cases" (Q 3d291a2b = A): POST /v1/case-drafts on the serve writes one tma-case/1 draft per trace into the
 * case store of the login (dfl-evals and one PR for a real login, a synthetic folder for the fixture login). The
 * result shows the count, each case and the PR link.
 * MT-20: one row = one trace = one run. A row links to /studio/traces/<trace_id>; the session is a column and a filter
 * (?session_id=).
 * Gaps against the artboard (the index has no such field or the studio has no such screen): the task title (the row
 * shows the task identifier), the merge state and CI result of the PR, the model size badge, the search box.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Card } from '../tma/ui'
import { useDismiss } from '../tma/ui/useDismiss'
import { AgentAvatar, ExternalRef, InfoTip, PinBadge, SignalChips, TaskSummaryBlock, TraceErrorCard, dash, fmtTime, useTraceLoad } from './TraceParts'
import { themeClass } from './theme'
import { L1_PAIRS_V4 } from './use-case'
import { CASE_SKIP_TEXT, caseBuildErrorText, isTraceId, postCaseDrafts, traceIdOf, type CaseDraftBuild, TRACE_PAGE_SIZE, agentChip, dayOf, fetchTraceList, newestFirst, plainValue, prFiles, prUrl, replayOf, shortDay, signalLabel, rowHref, sessionHref, trueSignals, type Replay, type TraceList, type TraceRow } from './traces'
import './studio.css'
import './traces.css'

const FILTERS = ['l2_class', 'why', 'mode', 'small_diff', 'session_id'] as const
type FilterKey = (typeof FILTERS)[number]
/** The group labels of the filter bar. The URL parameters keep the field keys. */
const FILTER_LABEL: Record<FilterKey, string> = { l2_class: 'Use case', why: 'Picked for', mode: 'Mode', small_diff: 'Small diff', session_id: 'Session' }
/** MT-11: a yes/no filter has fixed values; the other groups list the values on the page. */
const FIXED_VALUES: Partial<Record<FilterKey, Record<string, string>>> = { small_diff: { true: 'yes (merged, 3 files or fewer)', false: 'no' } }
const shortSession = (sid: string) => sid.slice(0, 8)
const valueText = (k: FilterKey, v: string) => (k === 'small_diff' ? (v === 'true' ? 'yes' : 'no') : k === 'session_id' ? shortSession(v) : plainValue(v))
const SMALL_DIFF_TIP = 'A merged PR that changed 3 files or fewer. Small, finished changes make clean cases.'

const ABOUT = 'Real agent sessions from the daily selection. A signal (a correction, a re-run, a revert) marks the traces with the most to teach. Read only. The content comes from the private trace service, not from the TMA server.'
const SIGNAL_TIP =
  'A sign that something went wrong or needed help in this session, spotted automatically. correction: a person told the agent it was wrong. re-run: it ran the same thing again. revert: the change was undone later. Traces with a signal teach the most.'

/** MT-12: the task name when the source gives one; else its id, else the session. */
function rowLabel(r: TraceRow): string {
  return r.task_name?.trim() || r.identifier || r.task_id || (r.session_id ? `Session ${r.session_id.slice(0, 8)}` : '(no id)')
}
const rowKey = (r: TraceRow, i: number) => `${r.trace_id ?? `${r.session_id ?? ''}:${r.agent_id ?? ''}`}:${i}`

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

/** MT-11: "Small diff: 2 files changed", or "4 files changed" when the PR is not small. */
function diffHint(r: TraceRow): string {
  const n = prFiles(r.pr)
  const files = n === null ? '' : `${n} ${n === 1 ? 'file' : 'files'} changed`
  return r.small_diff === true ? `Small diff${files ? `: ${files}` : ''}` : files
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
      // The selection checkbox takes the keyboard and pointer focus without moving the focused row.
      onFocus={(e) => {
        if (!(e.target as HTMLElement).closest('.trc-cell--check')) onFocus()
      }}
    >
      <span role="cell" className="trc-cell trc-cell--check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" className="trc-check-box" aria-label={`Select ${rowLabel(r)}`} checked={checked} onChange={onToggle} data-testid="trace-select" />
      </span>
      <span role="cell" className="trc-cell trc-cell--date" title={fmtTime(r.started_at)} data-field="started_at">
        {day ?? '—'}
      </span>
      <span role="cell" className="trc-cell trc-cell--agent" data-field="model">
        <AgentAvatar row={r} />
        {/* MT-19: the harness on line 1, the model under it, muted and small. */}
        <span className="trc-agent" title={`${a.name} · ${r.model ?? 'model ?'}`}>
          <span className="trc-agent__name trc-ellip">{a.name}</span>
          <span className="trc-agent__model trc-ellip" data-field="model-line">
            {r.model ?? 'model ?'}
          </span>
        </span>
      </span>
      <span role="cell" className="trc-cell trc-cell--task">
        <span className="trc-task-line">
          {!r.session_id ? (
            <span className="trc-task-id">{rowLabel(r)}</span>
          ) : r.has_trajectory ? (
            <Link to={rowHref(r)!} className="trc-task-id" data-testid="trace-link">
              {rowLabel(r)}
            </Link>
          ) : (
            <>
              <span className="trc-task-id">
                {rowLabel(r)}
              </span>
              <span className="trc-none" data-testid="trace-no-file">
                no trajectory file
              </span>
            </>
          )}
        </span>
      </span>
      <span role="cell" className="trc-cell trc-cell--session" data-field="session_id">
        {r.session_id ? (
          <Link to={sessionHref(r.session_id)} className="trc-session" title={`Show the runs of session ${r.session_id}`} data-testid="trace-session" onClick={(e) => e.stopPropagation()}>
            {shortSession(r.session_id)}
          </Link>
        ) : (
          '—'
        )}
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
      <ExternalRef id={r.external_id ?? r.identifier} url={r.external_url} />
      <section className="stu-section" aria-label="Task summary">
        <span className="trc-eyebrow">Task summary</span>
        {r.task_summary ? <TaskSummaryBlock summary={r.task_summary} /> : <p className="stu-label">No task summary.</p>}
      </section>
      <div className="trc-checks">
        <CheckLine ok={replay === 'yes'}>
          {replay === 'yes' ? 'Can be replayed exactly' : replay === 'partly' ? 'Can be replayed in part: the pin is incomplete' : replay === 'no' ? 'Cannot be replayed' : 'Not pinned yet: replay needs a pin'}
        </CheckLine>
        {signals.length > 0 && <CheckLine ok={false}>{`Signal: ${signals.map(signalLabel).join(', ')}`}</CheckLine>}
        {/* MT-11: the file-count hint; a small diff is a merged PR of 3 files or fewer. */}
        {(r.small_diff === true || prFiles(r.pr) !== null) && (
          <span data-testid="trace-diff-hint" data-small-diff={r.small_diff === true ? 'true' : 'false'}>
            <CheckLine ok={r.small_diff === true}>{diffHint(r)}</CheckLine>
          </span>
        )}
      </div>
      <details className="trc-details">
        <summary>Technical details</summary>
        <dl className="trc-kv">
          <dt>Trace</dt>
          <dd className="stu-label" data-field="trace_id">{dash(r.trace_id)}</dd>
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
          <dt>Files changed</dt>
          <dd data-field="files_changed">{dash(prFiles(r.pr))}</dd>
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
          <Link to={rowHref(r)!} className="stu-btn stu-btn--primary" data-testid="trace-open">
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
              const fixed = FIXED_VALUES[k]
              const values = fixed
                ? Object.keys(fixed)
                : [...new Set([...rows.map((r) => r[k as Exclude<FilterKey, 'small_diff'>]).filter((v): v is string => !!v), ...(current ? [current] : [])])].sort()
              return (
                <div key={k} className="trc-fgroup" data-filter={k} role="group" aria-label={FILTER_LABEL[k]}>
                  <span className="stu-label">{FILTER_LABEL[k]}</span>
                  {k === 'small_diff' && <span className="stu-label trc-fhint">{SMALL_DIFF_TIP}</span>}
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
                          {v === null ? 'all' : fixed ? fixed[v] : valueText(k, v)}
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
          {FILTER_LABEL[k]}: <span className="trc-fchip__v">{valueText(k, v)}</span>
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
        <Link to={hrefWith(params, { l2_class: null, why: null, mode: null, small_diff: null, session_id: null, offset: null })} className="trc-clear" data-testid="trace-clear">
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

type BuildState = { state: 'idle' } | { state: 'building'; n: number } | { state: 'done'; result: CaseDraftBuild } | { state: 'error'; text: string }

/** MT-05: the use case and the "Build N cases" button of the selection bar. */
function BuildCases({ n, traceIds, onBuilt, building }: { n: number; traceIds: string[]; onBuilt: (b: BuildState) => void; building: boolean }) {
  const [useCase, setUseCase] = useState('')
  const build = async () => {
    onBuilt({ state: 'building', n })
    try {
      onBuilt({ state: 'done', result: await postCaseDrafts({ trace_ids: traceIds, use_case: useCase }) })
    } catch (e) {
      onBuilt({ state: 'error', text: caseBuildErrorText(e) })
    }
  }
  const missing = traceIds.length === 0
  return (
    <>
      <label className="trc-selbar__uc">
        <span className="tma-body-sm tma-muted">Use case</span>
        <select value={useCase} onChange={(e) => setUseCase(e.target.value)} data-testid="trace-build-use-case" aria-label="Use case of the new cases">
          <option value="">Choose…</option>
          {L1_PAIRS_V4.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="stu-btn stu-btn--primary"
        disabled={!useCase || building || missing}
        title={missing ? 'The selected rows have no trace id' : !useCase ? 'Choose the use case of the new cases first' : 'Write one case draft per selected trace'}
        onClick={() => void build()}
        data-testid="trace-build-cases"
      >
        {building ? 'Building…' : `Build ${n} ${n === 1 ? 'case' : 'cases'}`}
      </button>
    </>
  )
}

/** MT-05: what the build made: the count, each case, the PR (eval repo) or the fixture note, and the skips. */
function BuildResult({ b, onClose }: { b: BuildState; onClose: () => void }) {
  if (b.state === 'idle' || b.state === 'building') return null
  if (b.state === 'error')
    return (
      <div className="trc-build trc-build--error" role="alert" data-testid="trace-build-error">
        <span>{b.text}</span>
        <button type="button" className="trc-selbar__clear" onClick={onClose}>
          Close
        </button>
      </div>
    )
  const r = b.result
  const n = r.created.length
  return (
    <div className="trc-build" role="status" data-testid="trace-build-result">
      <div className="trc-build__head">
        <strong data-testid="trace-build-count">
          {n} {n === 1 ? 'case' : 'cases'} created
        </strong>
        {r.pr_url ? (
          <a href={r.pr_url} target="_blank" rel="noreferrer" data-testid="trace-build-pr">
            Open the pull request in dfl-evals
          </a>
        ) : n > 0 && r.store === 'fixture' ? (
          <span className="tma-body-sm tma-muted">Fixture store: test drafts that stay on the trace host.</span>
        ) : null}
        <span className="trc-filters__fill" />
        <button type="button" className="trc-selbar__clear" onClick={onClose}>
          Close
        </button>
      </div>
      {n > 0 && (
        <ul className="trc-build__list" data-testid="trace-build-cases-list">
          {r.created.map((c) => (
            <li key={c.case_key}>
              <code>{c.path}</code>
            </li>
          ))}
        </ul>
      )}
      {r.skipped.length > 0 && (
        <ul className="trc-build__list tma-muted" data-testid="trace-build-skipped">
          {r.skipped.map((s) => (
            <li key={s.trace_id}>
              Skipped <code>{s.trace_id}</code>: {CASE_SKIP_TEXT[s.reason] ?? s.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

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
          {['date', 'agent', 'task', 'session', 'pr / ci', 'signal', 'replayable'].map((h) => (
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
  const [build, setBuild] = useState<BuildState>({ state: 'idle' })
  const offset = Number(params.get('offset') ?? '0')
  const q = {
    limit: TRACE_PAGE_SIZE,
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
    l2_class: params.get('l2_class'),
    why: params.get('why'),
    mode: params.get('mode'),
    small_diff: params.get('small_diff'),
    session_id: params.get('session_id'),
  }
  const loaded = useTraceLoad(() => fetchTraceList(q), [q.offset, q.l2_class, q.why, q.mode, q.small_diff, q.session_id])
  // A selection belongs to one page of one query: a new page or filter starts empty.
  useEffect(() => setSelected(new Set()), [q.offset, q.l2_class, q.why, q.mode, q.small_diff, q.session_id])
  // Newest first on each page. The serve pages by its own order, so the date order holds inside a page only.
  const keyed = loaded.state === 'ok' ? newestFirst(loaded.data.rows).map((r, i) => ({ r, k: rowKey(r, i) })) : []
  const focused = keyed.find((x) => x.k === focus) ?? keyed[0] ?? null
  // The trace id of each selected row: the served one, else the one computed from its session and agent (MT-20).
  const selectedIds = [...new Set(keyed.filter(({ k }) => selected.has(k)).map(({ r }) => (r.trace_id && isTraceId(r.trace_id) ? r.trace_id : r.session_id ? traceIdOf(r.session_id, r.agent_id) : null)).filter((id): id is string => !!id))]
  const onBuilt = (b: BuildState) => {
    setBuild(b)
    if (b.state === 'done' && b.result.created.length > 0) setSelected(new Set())
  }
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
                  <BuildCases n={selected.size} traceIds={selectedIds} onBuilt={onBuilt} building={build.state === 'building'} />
                </div>
              )}
              <BuildResult b={build} onClose={() => setBuild({ state: 'idle' })} />
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
