/**
 * S12 Routing index (plan 20261112-tma-c5-studio-area-web2, task C5-RD-S12), route /studio/routing. Read only.
 * Layout from the canvas artboard "S12 Routing recommendation": a table of every use case (use case, current agent,
 * suggested agent, verdict, runs, cost per task, state), the use cases with neither a route nor a passing agent in a
 * "no route" group, and a side panel for the selected row: the current and the suggested agent, what changes, the one
 * line the route PR changes (route target, its value now and its new value), the PR link and the route facts.
 * The approve and swap controls stay on the per-use-case page /studio/routing/:useCase (C8-T3): this page writes nothing.
 * Data: routing-index.ts (GET /routes, GET /eval-cases, GET /use-cases/:key/compare).
 * Gaps against the artboard: a route row has no "harness, instructions and tools stay the same" text, so the panel shows
 * the model, harness and agent digest of each side; there is no PR diff before a person approves a route (the target is
 * picked on approval), and the panel says so.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { InfoTip, TitleRow } from './chrome'
import { costText, formatScore, sha12 } from './compare'
import { CopyCommand } from './CopyCommand'
import { caseCommands } from './eval-command'
import { routingHref } from './links'
import { ROUTING_MIN_N } from './routing'
import { agentOf, changeText, costChange, loadRoutingIndex, prDiff, sortRows, STATE_TEXT, type AgentRef, type RoutingIndex, type RoutingRow, type RowState } from './routing-index'
import { themeClass } from './theme'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'
import './routing-index.css'

const ABOUT = `Which agent each use case should run. A suggestion is the cheapest agent with a passing verdict and at least ${ROUTING_MIN_N} runs. A person approves a route on the use case page; the change itself goes by a pull request. Read only.`
const COLS = ['use case', 'current agent', 'suggested agent', 'verdict', 'runs', 'cost per task', 'state']

const AV: Record<string, string> = { 'claude-code': 'cc', codex: 'cx', opencode: 'oc', ollama: 'al', local: 'al' }

function Avatar({ a }: { a: AgentRef | null }) {
  if (!a) return <span className="rix-av rix-av--none" aria-hidden="true" />
  const k = a.harness ? AV[a.harness] : undefined
  return (
    <span className={`rix-av${k ? ` rix-av--${k}` : ''}`} aria-hidden="true">
      {(k ?? a.harness ?? a.model).slice(0, 2)}
    </span>
  )
}

function Agent({ a, empty }: { a: AgentRef | null; empty: string }) {
  if (!a)
    return (
      <span className="rix-agent rix-agent--none">
        <Avatar a={null} />
        {empty}
      </span>
    )
  return (
    <span className="rix-agent" title={a.key ?? a.model}>
      <Avatar a={a} />
      <span className="rix-cell">
        {a.harness ? `${a.harness} · ` : ''}
        {a.model}
      </span>
    </span>
  )
}

type Tone = 'ok' | 'warn' | 'bad' | 'merged' | 'muted'
const PATH: Record<Tone, string> = { ok: 'm8 12 3 3 5-6', warn: 'M12 7v6M12 16.5h.01', bad: 'M9 9l6 6M15 9l-6 6', merged: 'M8 12h8M12 8v8', muted: 'M8 12h8' }

function Mark({ tone, children, testId }: { tone: Tone; children: React.ReactNode; testId?: string }) {
  return (
    <span className={`rix-mark rix-mark--${tone}`} data-testid={testId} data-tone={tone}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d={PATH[tone]} />
      </svg>
      {children}
    </span>
  )
}

const STATE_TONE: Record<RowState, Tone> = {
  live: 'ok',
  swap_pending: 'merged',
  approved: 'warn',
  proposed: 'warn',
  needs_check: 'warn',
  rolled_back: 'bad',
  ready: 'ok',
  needs_runs: 'muted',
  no_route: 'muted',
}
const VERDICT_TONE: Record<string, Tone> = { same: 'ok', better: 'ok', close: 'warn', worse: 'bad', not_yet: 'muted' }

function CostCell({ row }: { row: RoutingRow }) {
  const cur = agentOf(row, row.current?.key ?? null)
  const sug = agentOf(row, row.suggested?.key ?? null)
  const change = costChange(cur?.cost_per_task ?? null, sug?.cost_per_task ?? null)
  if (change)
    return (
      <span>
        <span className={change.endsWith('cheaper') ? 'rix-good' : undefined}>{change}</span>
        <span className="rix-sub">
          {costText(cur!.cost_per_task, cur!.cost_label)} → {costText(sug!.cost_per_task, sug!.cost_label)}
        </span>
      </span>
    )
  const one = sug ?? cur
  if (one && one.cost_per_task !== null) return <span>{costText(one.cost_per_task, one.cost_label)}</span>
  return <span className="rix-muted">no cost</span>
}

function Row({ row, on, onPick }: { row: RoutingRow; on: boolean; onPick: () => void }) {
  return (
    <div role="row" className={`rix-row${on ? ' rix-row--on' : ''}`} data-testid="s12-index-row" data-use-case={row.useCase} data-selected={on ? 'true' : undefined} onClick={onPick} onFocus={onPick}>
      <span role="cell" className="rix-cell">
        <Link to={routingHref(row.useCase)} className="rix-uc" data-testid="s12-index-link">
          {row.useCase}
        </Link>
        <span className="rix-sub">{row.cases === 1 ? '1 case' : `${row.cases} cases`}</span>
      </span>
      <span role="cell" className="rix-cell">
        <Agent a={row.current} empty="default agent" />
      </span>
      <span role="cell" className="rix-cell">
        {row.keep ? <Agent a={null} empty="keep current" /> : <Agent a={row.suggested} empty="none yet" />}
      </span>
      <span role="cell" className="rix-cell" data-testid="s12-index-verdict">
        <Mark tone={VERDICT_TONE[row.verdict] ?? 'muted'}>{row.verdict.replace('_', ' ')}</Mark>
      </span>
      <span role="cell" className="rix-cell rix-cell--num" data-testid="s12-index-runs">
        {row.runs}
      </span>
      <span role="cell" className="rix-cell">
        <CostCell row={row} />
      </span>
      <span role="cell" className="rix-cell" data-testid="s12-index-state">
        <Mark tone={STATE_TONE[row.state]}>{STATE_TEXT[row.state]}</Mark>
      </span>
    </div>
  )
}

function titleOf(row: RoutingRow): string {
  const m = (a: AgentRef | null) => (a ? a.model : 'the default agent')
  if (row.suggested && row.current) return `Swap ${m(row.current)} for ${m(row.suggested)}`
  if (row.suggested) return `Route to ${m(row.suggested)}`
  if (row.live) return row.keep ? `Keep ${m(row.current)}` : `Live: ${m(row.current)}`
  return row.runs > 0 ? 'No agent passes yet' : 'No runs yet'
}

/** Plain words from the data: what the evidence says for this use case. */
function summaryOf(row: RoutingRow): string {
  const sug = agentOf(row, row.suggested?.key ?? null) ?? row.rec?.agent ?? null
  if (sug) {
    const cost = sug.cost_per_task !== null ? ` at ${costText(sug.cost_per_task, sug.cost_label)} a task` : ''
    return `In ${sug.n} runs, ${sug.model_id} scored ${formatScore(sug.mean_score)} on average${cost}. Verdict: ${row.verdict.replace('_', ' ')}.`
  }
  const agents = row.compare?.agents ?? []
  if (agents.length === 0) return `${row.useCase} has no counted run yet. A route needs an agent with at least ${ROUTING_MIN_N} runs and a passing verdict.`
  const most = [...agents].sort((a, b) => b.n - a.n)[0]!
  return `${row.useCase} has ${row.runs} counted ${row.runs === 1 ? 'run' : 'runs'} over ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}; the most runs are ${most.n} for ${most.model_id}. A route needs an agent with at least ${ROUTING_MIN_N} runs and a passing verdict (SAME or CLOSE, or better or same).`
}

/** The side panel: the selected use case. */
export function RoutingPanel({ row }: { row: RoutingRow }) {
  const route = row.pending ?? row.live
  const diff = route ? prDiff(route) : null
  const change = changeText(row.current, row.suggested)
  const repeat = row.compare?.profile.min_runs_per_cell ?? ROUTING_MIN_N
  return (
    <div className="rix-aside__in" data-testid="s12-index-panel" data-use-case={row.useCase}>
      <div>
        <span className="rix-eyebrow">{row.useCase.replace('/', ' / ')}</span>
        <h2 className="rix-title">{titleOf(row)}</h2>
      </div>
      <div className="rix-agents">
        <span className="rix-card">
          <Agent a={row.current} empty="default agent" />
          {row.current?.key && <span className="rix-sub">{sha12(row.current.key.split('#')[1] ?? '')}</span>}
        </span>
        {row.suggested && (
          <>
            <span className="rix-arrow" aria-hidden="true">
              ↓
            </span>
            <span className="rix-card rix-card--to">
              <Agent a={row.suggested} empty="none" />
              {row.suggested.key && <span className="rix-sub">{sha12(row.suggested.key.split('#')[1] ?? '')}</span>}
            </span>
          </>
        )}
        {change && <span className="rix-muted">{change}</span>}
      </div>
      <p className="rix-prose" data-testid="s12-index-summary">
        {summaryOf(row)}
      </p>
      <section aria-label="The PR" data-testid="s12-index-diff-section">
        <p className="rix-muted">The PR changes one line</p>
        {diff ? (
          <pre className="rix-diff" data-testid="s12-index-diff">
            <span className="rix-diff__file"># {diff.file}</span>
            {diff.minus && <span className="rix-diff__minus">- {diff.minus}</span>}
            <span className="rix-diff__plus">+ {diff.plus}</span>
          </pre>
        ) : (
          <p className="tma-body-sm rix-muted" data-testid="s12-index-no-diff">
            No route yet, so no PR. A person approves a route on the use case page and picks the routing target there; then <span className="tma-mono">tma route pr</span>{' '}
            opens the PR, and its one-line change shows here.
          </p>
        )}
        {diff && !diff.minus && <p className="tma-body-sm rix-muted">The value in the file at approval time was not known.</p>}
      </section>
      <details className="rix-details">
        <summary>{route ? 'When we check this route again' : 'Ask for more runs'}</summary>
        {route ? (
          <dl className="rix-kv">
            <dt>State</dt>
            <dd>{route.state}</dd>
            <dt>Rule</dt>
            <dd>{route.picked_rule}</dd>
            <dt>Evidence</dt>
            <dd>{route.n} runs</dd>
            <dt>Policy</dt>
            <dd className="tma-mono">{route.policy_version}</dd>
            {route.approved_at && (
              <>
                <dt>Approved</dt>
                <dd>{route.approved_at.slice(0, 10)}</dd>
              </>
            )}
            {route.live_at && (
              <>
                <dt>Live since</dt>
                <dd>{route.live_at.slice(0, 10)}</dd>
              </>
            )}
          </dl>
        ) : (
          <CopyCommand command={caseCommands({ caseKey: '<case key>', useCaseKey: row.useCase, mode: 'run' }, { repeat }).join('\n')} title={`${repeat} more runs with the kit`} testId="s12-index-command" />
        )}
      </details>
      <div className="rix-actions">
        {route?.pr_url && (
          <a href={route.pr_url} target="_blank" rel="noreferrer" className="stu-btn stu-btn--primary" data-testid="s12-index-pr">
            Open the PR
          </a>
        )}
        <Link to={routingHref(row.useCase)} className={`stu-btn ${route?.pr_url ? 'stu-btn--secondary' : 'stu-btn--primary'}`} data-testid="s12-index-open">
          Open the use case
        </Link>
      </div>
    </div>
  )
}

export function RoutingIndexView({ data }: { data: RoutingIndex }) {
  const { routed, noRoute } = sortRows(data.rows)
  const [sel, setSel] = useState<string | null>(null)
  const all = [...routed, ...noRoute]
  const cur = all.find((r) => r.useCase === sel) ?? all[0] ?? null
  return (
    <div className="rix-shell">
      <div className="rix-col">
        <p className="stu-label rix-crumb">
          <Link to="/studio">Studio</Link> / routing
        </p>
        <TitleRow tip={<InfoTip label="About routing" text={ABOUT} />}>
          <h1 className="tma-h1">Routing</h1>
        </TitleRow>
        {data.routesError !== null && (
          <p className="stu-gap" data-testid="s12-index-routes-error">
            The routes could not be read ({loadErrorText(data.routesError)}). Rows show the evidence only.
          </p>
        )}
        {all.length === 0 ? (
          <div className="rix-state" data-testid="s12-index-empty">
            <span className="tma-label">No use cases yet</span>
            <p className="tma-body-sm tma-muted">A use case appears here when one of your test cases has a taxonomy pair type/subtype, or when a route names it.</p>
          </div>
        ) : (
          <div className="rix-tablewrap">
            <div role="table" aria-label="Routes" className="rix-table" data-testid="s12-index-table">
              <div role="row" className="rix-row rix-row--head">
                {COLS.map((c, i) => (
                  <span key={c} role="columnheader" className={i === 4 ? 'rix-cell rix-cell--num' : 'rix-cell'}>
                    {c}
                  </span>
                ))}
              </div>
              {routed.map((r) => (
                <Row key={r.useCase} row={r} on={cur?.useCase === r.useCase} onPick={() => setSel(r.useCase)} />
              ))}
              {noRoute.length > 0 && (
                <div role="rowgroup" data-testid="s12-index-no-route">
                  <div className="rix-group">
                    no route · {noRoute.length}
                    <InfoTip label="About no route" text="No route row and no agent with a passing verdict yet. These use cases run the default agent." />
                  </div>
                  {noRoute.map((r) => (
                    <Row key={r.useCase} row={r} on={cur?.useCase === r.useCase} onPick={() => setSel(r.useCase)} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {cur && (
        <aside className="rix-aside" aria-label="Selected use case">
          <RoutingPanel row={cur} />
        </aside>
      )}
    </div>
  )
}

export function StudioRoutingIndexPage({ data }: { data?: RoutingIndex }) {
  const loaded = useStudioLoad(data ? null : loadRoutingIndex, [data ? 'prop' : 'api'])
  const shown = data ?? (loaded.state === 'ok' ? loaded.data : null)
  return (
    <main className={themeClass('tma-page', 'stu-page', 'rix-page')} data-testid="studio-routing-index">
      {shown && <RoutingIndexView data={shown} />}
      {!shown && (
        <div className="rix-col">
          <p className="stu-label rix-crumb">
            <Link to="/studio">Studio</Link> / routing
          </p>
          <h1 className="tma-h1">Routing</h1>
          {loaded.state === 'error' ? (
            <div className="rix-state" data-testid="s12-index-error">
              <span className="tma-label">Routing is not available</span>
              <p className="tma-body-sm tma-muted">{loadErrorText(loaded.status)}</p>
            </div>
          ) : (
            <p className="tma-body-sm tma-muted">Loading routes…</p>
          )}
        </div>
      )}
    </main>
  )
}
