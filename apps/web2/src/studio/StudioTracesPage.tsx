/**
 * S2 Trace picker (plan 20261112-tma-c5-studio-area-web2, task C5-T6). Read only.
 * Candidate fleet traces from the daily trace-select output, served by `tma studio serve` (GET /v1/traces) through
 * studio/traces.ts. The content never comes from, and never goes to, the TMA server (parent ADR-1).
 * Filters (URL query): l2_class, why, mode; paging: offset, page size 50. Each row links to S3.
 */
import { Link, useSearchParams } from 'react-router-dom'
import { Card, CardHeader } from '../tma/ui'
import { PinBadge, SignalChips, TaskSummaryBlock, TraceErrorCard, WhyBadge, dash, fmtTime, useTraceLoad } from './TraceParts'
import { TRACE_PAGE_SIZE, fetchTraceList, prUrl, traceHref, type TraceList, type TraceRow } from './traces'
import './studio.css'

const FILTERS = ['l2_class', 'why', 'mode'] as const
type FilterKey = (typeof FILTERS)[number]

function rowLabel(r: TraceRow): string {
  return r.identifier ?? r.task_id ?? (r.session_id ? r.session_id.slice(0, 8) : '(no id)')
}

function TraceRowCard({ r }: { r: TraceRow }) {
  const pr = prUrl(r.pr)
  const who = [r.executor, r.harness, r.host].filter(Boolean).join(' / ')
  return (
    <li className="trc-row" data-trace-row="" data-session-id={r.session_id ?? ''}>
      <div className="trc-row__head">
        <span className="tma-mono trc-row__id" title={r.session_id ?? undefined}>
          {rowLabel(r)}
        </span>
        {r.agent_id && <span className="tma-mono tma-muted trc-small">agent {r.agent_id}</span>}
        <WhyBadge why={r.why} />
        <span className="trc-small" data-field="l2_class">
          {dash(r.l2_class)}
        </span>
        <span className="trc-small tma-muted" data-field="mode">
          {dash(r.mode)}
        </span>
        <PinBadge pin={r.pin} />
      </div>
      <div className="trc-row__meta tma-muted trc-small">
        <span data-field="model">{dash(r.model)}</span>
        {who && <span data-field="who">{who}</span>}
        <span data-field="started_at">{fmtTime(r.started_at)}</span>
        <SignalChips signals={r.signals} />
        {pr && (
          <a href={pr} target="_blank" rel="noreferrer" data-testid="trace-pr">
            PR
          </a>
        )}
      </div>
      {r.task_summary ? <TaskSummaryBlock summary={r.task_summary} /> : <p className="trc-small tma-muted">No task summary.</p>}
      <div className="trc-small">
        {!r.session_id ? null : r.has_trajectory ? (
          <Link to={traceHref(r.session_id, r.agent_id)} data-testid="trace-link">
            Open trace
          </Link>
        ) : (
          <span className="tma-muted" data-testid="trace-no-file">
            no trajectory file
          </span>
        )}
      </div>
    </li>
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

function FilterBar({ params, rows }: { params: URLSearchParams; rows: TraceRow[] }) {
  return (
    <div className="trc-filters" data-testid="trace-filters">
      {FILTERS.map((k: FilterKey) => {
        const current = params.get(k)
        const values = [...new Set([...rows.map((r) => r[k]).filter((v): v is string => !!v), ...(current ? [current] : [])])].sort()
        return (
          <span key={k} className="trc-filter" data-filter={k}>
            <span className="tma-label">{k}</span>
            {[null, ...values].map((v) => {
              const active = (v ?? null) === (current ?? null)
              return (
                <Link
                  key={v ?? '(all)'}
                  to={hrefWith(params, { [k]: v, offset: null })}
                  className={active ? 'trc-filter__opt trc-filter__opt--on' : 'trc-filter__opt'}
                  aria-current={active ? 'true' : undefined}
                  data-filter-value={v ?? 'all'}
                >
                  {v ?? 'all'}
                </Link>
              )
            })}
          </span>
        )
      })}
    </div>
  )
}

function Paging({ params, data }: { params: URLSearchParams; data: TraceList }) {
  const from = data.total === 0 ? 0 : data.offset + 1
  const to = data.offset + data.rows.length
  const prev = data.offset > 0 ? Math.max(0, data.offset - data.limit) : null
  const next = to < data.total ? data.offset + data.limit : null
  return (
    <p className="trc-paging tma-body-sm" data-testid="trace-paging">
      {prev !== null && (
        <Link to={hrefWith(params, { offset: prev ? String(prev) : null })} data-testid="trace-prev">
          Prev
        </Link>
      )}{' '}
      <span data-testid="trace-count">
        {from}–{to} of {data.total}
      </span>{' '}
      {next !== null && (
        <Link to={hrefWith(params, { offset: String(next) })} data-testid="trace-next">
          Next
        </Link>
      )}
    </p>
  )
}

export function StudioTracesPage() {
  const [params] = useSearchParams()
  const offset = Number(params.get('offset') ?? '0')
  const q = {
    limit: TRACE_PAGE_SIZE,
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
    l2_class: params.get('l2_class'),
    why: params.get('why'),
    mode: params.get('mode'),
  }
  const loaded = useTraceLoad(() => fetchTraceList(q), [q.offset, q.l2_class, q.why, q.mode])
  return (
    <main className="tma-page" data-testid="studio-traces">
      <div className="stu-head">
        <p className="tma-body-sm">
          <Link to="/studio">Studio</Link> / traces
        </p>
        <h1 className="tma-h1">Traces</h1>
        <p className="stu-sub">Candidate fleet traces from the daily selection. Read only. The content comes from the private trace service, not from the TMA server.</p>
      </div>
      {loaded.state === 'loading' ? (
        <Card pad data-testid="traces-loading">
          <span className="tma-body-sm tma-muted">Loading traces…</span>
        </Card>
      ) : loaded.state === 'error' ? (
        <TraceErrorCard error={loaded.error} testId="traces-error" />
      ) : (
        <Card data-testid="traces-list">
          <CardHeader title="Candidate traces" meta={`selection ${loaded.data.source.selection_day}`} />
          <div className="stu-pad">
            <p className="tma-body-sm tma-muted" data-testid="trace-source">
              Selection day {loaded.data.source.selection_day}. {loaded.data.source.pins ? 'Pins exist for this day.' : 'No pins for this day.'}
            </p>
            <FilterBar params={params} rows={loaded.data.rows} />
            {loaded.data.rows.length === 0 ? (
              <p className="tma-body-sm tma-muted" data-testid="traces-empty">
                No candidate traces match these filters.
              </p>
            ) : (
              <ul className="trc-rows">
                {loaded.data.rows.map((r, i) => (
                  <TraceRowCard key={`${r.session_id ?? ''}:${r.agent_id ?? ''}:${i}`} r={r} />
                ))}
              </ul>
            )}
            <Paging params={params} data={loaded.data} />
          </div>
        </Card>
      )}
    </main>
  )
}
