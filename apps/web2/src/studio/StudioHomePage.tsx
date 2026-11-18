/**
 * S1 Studio home (plan 20261112-tma-c5-studio-area-web2, task C5-T1; redesign C5-RD-S1; canvas artboard "ToBeHome").
 * Use cases above folders: one table row per L1 pair type/subtype (parent Q-T17 = A), grouped under its type, with the
 * columns of the artboard: cases, best score, cost per task, verdict (both rules, Q-T22 = C), route agent. Under each row,
 * its test cases link to S4. The Group and Verdict controls only change the view.
 * Studio v1 is READ ONLY (Q-T18 = A): no Save and no Run here. "New eval from a trace" is a link to S2.
 * Data: GET /eval-cases (capped by the API; the page says so when the list is truncated), then per use case
 * GET /use-cases/:key/compare (S8) and GET /routes?use_case= (S12). A failed per-use-case call shows dashes, never a
 * made-up value. The `cases` and `summaries` props are test seams: with `cases`, the page calls no API.
 * The same page serves /studio/cases (the S4 list); there `?task=<slug>` keeps the cases of one task.
 * ADR-1: the web2 nav stays and the studio has no own top bar: the links to the other studio screens sit under the table.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { STUDIO_SERVE_URL } from '../config'
import { api } from '../lib/api'
import { InfoTip, TitleRow } from './chrome'
import { getUseCaseCompare } from './compare'
import { agentGround, agentLetters, costText, passesVerdict, scoreText, summarizeUseCase, VERDICT_FILTERS, type UseCaseSummary, type VerdictFilter } from './home'
import { studioHref } from './links'
import { getRoutes } from './routing'
import { themeClass } from './theme'
import { groupByUseCase, isL1Pair, splitUseCaseKey, type StudioCase } from './use-case'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'
import './home.css'

const USE_CASE_TIP = 'One use case = one L1 pair type/subtype of the task taxonomy. Its test cases sit under it. Routing decisions are per use case.'
const VERDICT_TIP =
  'From the comparison rule: the cheapest agent with at least 5 runs that scores the same as the current one (same), within the margin (close), or none yet (not yet). The second label is the relative rule (better, tie, worse) of the same agent.'
const ROUTE_TIP = 'A route points a use case to an agent: a harness plus a model. Use cases with no live route use the workspace default agent.'

type Grouping = 'type' | 'none'

function useSummaries(keys: string[], enabled: boolean): Record<string, UseCaseSummary> {
  const [map, setMap] = useState<Record<string, UseCaseSummary>>({})
  const sig = keys.join('|')
  useEffect(() => {
    if (!enabled || keys.length === 0) return
    let live = true
    for (const key of keys) {
      Promise.allSettled([getUseCaseCompare(key), getRoutes(key)]).then(([c, r]) => {
        if (!live) return
        const compare = c.status === 'fulfilled' ? c.value : null
        const routes = r.status === 'fulfilled' ? r.value.routes : null
        setMap((m) => ({ ...m, [key]: summarizeUseCase(compare, routes) }))
      })
    }
    return () => {
      live = false
    }
  }, [sig, enabled])
  return map
}

function VerdictIcon({ verdict }: { verdict: UseCaseSummary['verdict'] }) {
  const d = verdict === 'same' ? 'm8 12 3 3 5-6' : verdict === 'close' ? 'M7.5 10.5c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0M7.5 14.5c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0' : 'm15 9-6 6M9 9l6 6'
  return (
    <svg className={`s1-vicon s1-vicon--${verdict === 'not yet' ? 'no' : verdict}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d={d} />
    </svg>
  )
}

function AgentTile({ name, model, small }: { name: string; model: string; small?: boolean }) {
  return (
    <span className={`s1-tile${small ? ' s1-tile--sm' : ''}`} aria-hidden="true">
      <span className={`s1-tile__ground s1-tile__ground--${agentGround(name)}`}>{agentLetters(name)}</span>
      <span className="s1-tile__badge">{(model.replace(/^.*\//, '')[0] ?? '?').toUpperCase()}</span>
    </span>
  )
}

function RouteCell({ s }: { s: UseCaseSummary | undefined }) {
  if (!s) return <span className="tma-muted">—</span>
  if (!s.routeModel)
    return (
      <span className="s1-route s1-route--none" data-testid="s1-route-none">
        <span className="s1-tile s1-tile--empty" aria-hidden="true" />
        <span>no route</span>
        <span className="tma-muted">· default agent</span>
      </span>
    )
  const harness = s.routeHarness ?? s.routeModel
  return (
    <span className="s1-route-stack">
      <span className="s1-route" data-testid="s1-route">
        <AgentTile name={harness} model={s.routeModel} />
        <span>
          {s.routeHarness ? `${s.routeHarness} · ` : ''}
          {s.routeModel}
        </span>
      </span>
      {s.fallbackModel && (
        <span className="s1-route s1-route--fallback" data-testid="s1-route-fallback">
          <span className="s1-route__elbow" aria-hidden="true">└</span>
          <AgentTile name={harness} model={s.fallbackModel} small />
          <span>{s.fallbackModel}</span>
        </span>
      )}
    </span>
  )
}

function UseCaseRow({ useCaseKey, cases, summary }: { useCaseKey: string; cases: StudioCase[]; summary: UseCaseSummary | undefined }) {
  const { type, subtype } = splitUseCaseKey(useCaseKey)
  return (
    <div className="s1-uc" data-testid={`use-case-${useCaseKey}`}>
      <div className="s1-grid s1-row" role="row">
        <span role="cell" className="s1-name">
          <Link to={studioHref('S8', { use_case: useCaseKey })} data-testid="s1-use-case-link">
            {type} / {subtype ?? 'general'}
          </Link>
        </span>
        <span role="cell" className="s1-num" data-testid="s1-cases">
          {cases.length}
        </span>
        <span role="cell" className="s1-num" data-testid="s1-best-score">
          {summary ? scoreText(summary.bestScore) : '—'}
        </span>
        <span role="cell" className="s1-num" data-testid="s1-cost">
          {summary ? costText(summary.costPerTask) : '—'}
        </span>
        <span role="cell" className="s1-verdict" data-testid="s1-verdict" data-verdict={summary?.verdict ?? undefined}>
          {summary?.verdict ? (
            <>
              <VerdictIcon verdict={summary.verdict} />
              {summary.verdict}
              {summary.relative && <span className="tma-muted s1-rel"> · {summary.relative}</span>}
            </>
          ) : (
            <span className="tma-muted">—</span>
          )}
        </span>
        <span role="cell">
          <RouteCell s={summary} />
        </span>
      </div>
      <ul className="s1-cases" aria-label={`Test cases of ${useCaseKey}`}>
        {cases.map((c) => (
          <li key={c.id ?? c.caseKey} data-testid="studio-case">
            {c.id ? (
              <Link to={`/studio/cases/${encodeURIComponent(c.id)}`} data-testid="studio-case-link">
                {c.caseKey}
              </Link>
            ) : (
              c.caseKey
            )}
            {c.runCount != null && (
              <span className="tma-muted">
                {' '}
                · {c.runCount} {c.runCount === 1 ? 'run' : 'runs'}
              </span>
            )}
            {c.cluster ? (
              <span className="s1-tag" data-testid="l2-tag">
                {c.cluster}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function StudioHomePage({ cases, summaries }: { cases?: StudioCase[]; summaries?: Record<string, UseCaseSummary> }) {
  const [params] = useSearchParams()
  const task = params.get('task')
  const [grouping, setGrouping] = useState<Grouping>('type')
  const [verdict, setVerdict] = useState<VerdictFilter>('all')
  const loaded = useStudioLoad(
    cases ? null : () => api.evalCases().then((r) => ({ cases: r.cases as StudioCase[], truncated: r.truncated, limit: r.limit })),
    [cases ? 'prop' : 'api'],
  )
  const all = cases ?? (loaded.state === 'ok' ? loaded.data.cases : [])
  const list = task ? all.filter((c) => c.taskSlug === task) : all
  const groups = groupByUseCase(list.filter((c) => isL1Pair(c.useCaseKey)))
  const keys = useMemo(() => groups.flatMap((g) => g.subtypes.map((s) => (s.subtype ? `${g.type}/${s.subtype}` : g.type))), [groups.map((g) => g.type + g.total).join()])
  const fetched = useSummaries(keys, !cases && !summaries)
  const sums = summaries ?? fetched
  // A name that is not one of the 33 pairs never gets its own use case row (Q-T17 = A).
  const unclassified = list.filter((c) => !isL1Pair(c.useCaseKey)).sort((x, y) => x.caseKey.localeCompare(y.caseKey))
  const loading = !cases && loaded.state === 'loading'
  const error = !cases && loaded.state === 'error' ? loaded : null

  const rowsOf = (g: (typeof groups)[number]) =>
    g.subtypes
      .map((s) => ({ key: s.subtype ? `${g.type}/${s.subtype}` : g.type, cases: s.cases }))
      .filter((r) => passesVerdict(sums[r.key], verdict))
  const shownGroups = groups.map((g) => ({ g, rows: rowsOf(g) })).filter((x) => x.rows.length > 0)
  const flatRows = shownGroups.flatMap((x) => x.rows)

  return (
    <main className={themeClass('tma-page', 'stu-page', 's1-page')} data-testid="studio-home">
      <div className="stu-body stu-body--tight">
        <TitleRow
          tip={<InfoTip label="About use cases" text={USE_CASE_TIP} />}
          actions={
            <>
              <label className="s1-select">
                <span>Group:</span>
                <select value={grouping} onChange={(e) => setGrouping(e.target.value as Grouping)} data-testid="s1-group">
                  <option value="type">verb</option>
                  <option value="none">none</option>
                </select>
              </label>
              <label className="s1-select">
                <span>Verdict:</span>
                <select value={verdict} onChange={(e) => setVerdict(e.target.value as VerdictFilter)} data-testid="s1-verdict-filter">
                  {VERDICT_FILTERS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              {STUDIO_SERVE_URL && (
                <Link to="/studio/traces" className="s1-primary" data-testid="s1-new-eval">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14" />
                    <path d="M12 5v14" />
                  </svg>
                  New eval from a trace
                </Link>
              )}
            </>
          }
        >
          <h1 className="tma-h1">Use cases</h1>
        </TitleRow>
        {task && (
          <p className="tma-body-sm" data-testid="studio-task-filter">
            Test cases of the task <Link to={`/tasks/${encodeURIComponent(task)}`}>{task}</Link>. <Link to="/studio/cases">Show every case</Link>
          </p>
        )}

        {loading ? (
          <p className="tma-body-sm tma-muted" data-testid="studio-loading">
            Loading test cases…
          </p>
        ) : groups.length === 0 && unclassified.length === 0 ? (
          <div className="s1-empty" data-testid="studio-empty">
            <span className="tma-label">No test cases yet</span>
            {error && (
              <p className="tma-body-sm tma-muted" data-testid="studio-load-error">
                {loadErrorText(error.status)}
              </p>
            )}
            <p className="tma-body-sm tma-muted">
              A test case appears here when it is uploaded with the <span className="tma-mono">tma</span> command. Code tasks are on the{' '}
              <Link to="/tasks" data-testid="studio-tasks-link">
                Tasks
              </Link>{' '}
              page.
            </p>
          </div>
        ) : (
          <div className="s1-table-wrap">
            <div role="table" aria-label="Use cases" className="s1-table" data-testid="s1-table">
              <div className="s1-grid s1-head" role="row">
                <span role="columnheader">use case</span>
                <span role="columnheader" className="s1-num">
                  cases
                </span>
                <span role="columnheader" className="s1-num">
                  best score
                </span>
                <span role="columnheader" className="s1-num">
                  cost / task
                </span>
                <span role="columnheader" className="s1-th-tip">
                  verdict
                  <InfoTip label="About verdict" text={VERDICT_TIP} />
                </span>
                <span role="columnheader" className="s1-th-tip">
                  route: agent
                  <InfoTip label="About routes" text={ROUTE_TIP} />
                </span>
              </div>
              {grouping === 'type'
                ? shownGroups.map(({ g, rows }) => (
                    <div key={g.type} role="rowgroup" data-testid={`use-case-${g.type}`}>
                      <div className="s1-group" role="row">
                        <span role="cell">
                          {g.type} · {rows.length}
                        </span>
                      </div>
                      {rows.map((r) => (
                        <UseCaseRow key={r.key} useCaseKey={r.key} cases={r.cases} summary={sums[r.key]} />
                      ))}
                    </div>
                  ))
                : flatRows.map((r) => <UseCaseRow key={r.key} useCaseKey={r.key} cases={r.cases} summary={sums[r.key]} />)}
              {flatRows.length === 0 && groups.length > 0 && (
                <p className="tma-body-sm tma-muted s1-none" data-testid="s1-filter-empty">
                  No use case has the verdict “{verdict}”.
                </p>
              )}
            </div>
          </div>
        )}
        {unclassified.length > 0 ? (
          <section className="s1-unclassified" data-testid="use-case-unclassified">
            <h2 className="s1-group">
              Not a taxonomy pair · {unclassified.length} {unclassified.length === 1 ? 'case' : 'cases'}
            </h2>
            <ul className="s1-cases">
              {unclassified.map((c) => (
                <li key={c.caseKey} data-testid="studio-case">
                  {c.caseKey} <span className="tma-muted">({c.useCaseKey})</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {/* ADR-1: no own top bar, so the other studio screens are linked here, under the table. */}
        <nav className="s1-links" aria-label="Studio screens">
          <span className="tma-muted">Also in the studio:</span>
          <Link to="/studio/graders" data-testid="studio-graders-link">
            Graders
          </Link>
          <Link to="/studio/trajectories" data-testid="studio-trajectories-link">
            Trajectories
          </Link>
          <Link to="/studio/compare" data-testid="studio-compare-link">
            Compare
          </Link>
          <Link to="/studio/calibration" data-testid="studio-calibration-link">
            Calibration
          </Link>
          <Link to="/studio/review" data-testid="studio-review-link">
            Review
          </Link>
          {/* C5-T6: S2 reads from `tma studio serve`; the link shows only when its URL is set. */}
          {STUDIO_SERVE_URL && (
            <Link to="/studio/traces" data-testid="studio-traces-link">
              Traces
            </Link>
          )}
        </nav>
        {!loading && (groups.length > 0 || unclassified.length > 0) && (
          <p className="tma-body-sm tma-muted s1-foot">
            {!cases && loaded.state === 'ok' && loaded.data.truncated && <span data-testid="studio-truncated">Showing the newest {loaded.data.limit} test cases. </span>}
            Code tasks are on the{' '}
            <Link to="/tasks" data-testid="studio-tasks-link">
              Tasks
            </Link>{' '}
            page.
          </p>
        )}
      </div>
    </main>
  )
}
