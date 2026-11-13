/**
 * S8 Agent compare per use case (plan 20261112-tma-c7-model-comparison-per-use-case, task C7-T4), route
 * /studio/compare. Query: ?use_case=<type/subtype> and an optional ?current=<agent key>.
 *
 *   no use_case   a list of the L1 pairs that the caller's test cases hold (GET /eval-cases), each a link here.
 *   use_case      GET /use-cases/:key/compare: the profile notice, a Pareto chart (mean score over cost per task), a
 *                 table with one row per agent (n, distribution, hard gates, cost and its label, wall time, BOTH
 *                 verdict columns side by side, the Pareto status), the rule texts, and the kit commands that add
 *                 samples to a cell.
 *
 * ADR-7: every verdict, score, front and dominated flag comes from the response; this page computes none. A cell
 * with too few runs shows its numbers and "not enough runs", never a SAME / CLOSE label.
 * Read only (Q-T18 = A): the copy command is the one button; the current-agent <select> only changes the query.
 * The `data` and `cases` props are test seams.
 */
import { useId } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { Card, CardHeader, ModelAvatar } from '../tma/ui'
import {
  absoluteText,
  formatCost,
  formatGap,
  formatScore,
  formatWall,
  getUseCaseCompare,
  notPlottedReason,
  paretoText,
  providerOf,
  relativeReasonText,
  relativeText,
  sha12,
  sortAgents,
  type CompareAgent,
  type UseCaseCompareResponse,
} from './compare'
import { CopyCommand } from './CopyCommand'
import { caseCommands } from './eval-command'
import { routingHref, studioHref } from './links'
import { isL1Pair, type StudioCase } from './use-case'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

type Profile = UseCaseCompareResponse['profile']

function thresholds(p: Profile): string {
  return `SAME at ${p.absolute_bars.same}, CLOSE at ${p.absolute_bars.close}; margin ${p.relative_margin_points} points; at least ${p.min_runs_per_cell} runs per cell.`
}

/** How the numbers were weighted, read from the response fields (never a constant). */
export function ProfileNotice({ profile }: { profile: Profile }) {
  const pinned = profile.source !== 'defaults' || profile.sha256 !== null
  return (
    <p className="tma-body-sm s8-notice" data-testid="s8-profile-notice" data-profile-source={profile.source}>
      {pinned ? (
        <>
          Profile <span className="tma-mono">{profile.source}</span>, sha256{' '}
          <span className="tma-mono">{profile.sha256 ? sha12(profile.sha256) : 'not given'}</span>. Weights:{' '}
          <span className="tma-mono">{profile.weights}</span>. Thresholds: {thresholds(profile)}
        </>
      ) : (
        <>
          {profile.weights === 'stored_per_result'
            ? `Scores use the weights that each run stored when it was graded. Default thresholds: ${thresholds(profile)}`
            : `Weights: ${profile.weights}. Default thresholds: ${thresholds(profile)}`}{' '}
          These are the default bars, not a per-use-case weight profile pinned from dfl-evals.
        </>
      )}
    </p>
  )
}

const W = 520
const H = 280
const PAD = { left: 48, right: 24, top: 16, bottom: 40 }

/** Inline SVG Pareto chart: mean score (Y) over cost per task (X). Front vs dominated by shape and stroke, not colour. */
export function ParetoChart({ data }: { data: UseCaseCompareResponse }) {
  const min = data.profile.min_runs_per_cell
  const plotted = data.agents.filter((a) => notPlottedReason(a, min) === null)
  const skipped = data.agents.filter((a) => notPlottedReason(a, min) !== null)
  const maxCost = Math.max(0, ...plotted.map((a) => a.cost_per_task as number))
  const xMax = maxCost > 0 ? maxCost * 1.1 : 1
  const x = (c: number) => PAD.left + (c / xMax) * (W - PAD.left - PAD.right)
  const y = (s: number) => PAD.top + (1 - s / 100) * (H - PAD.top - PAD.bottom)
  const front = plotted.filter((a) => a.pareto.on_front).sort((a, b) => (a.cost_per_task as number) - (b.cost_per_task as number))
  return (
    <Card data-testid="s8-pareto">
      <CardHeader title="Score and cost" meta={`${plotted.length} of ${data.agents.length} agents plotted`} />
      <div className="stu-pad">
        <div className="s8-chart-wrap">
          <svg
            className="s8-chart"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Mean score over cost per task for ${plotted.length} agents. ${front.length} on the Pareto front.`}
            data-testid="s8-pareto-svg"
          >
            <line className="s8-axis" x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} />
            <line className="s8-axis" x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} />
            {[0, 50, 100].map((t) => (
              <text key={t} className="s8-tick" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                {t}
              </text>
            ))}
            <text className="s8-tick" x={PAD.left} y={H - PAD.bottom + 16} textAnchor="middle">
              $0
            </text>
            <text className="s8-tick" x={W - PAD.right} y={H - PAD.bottom + 16} textAnchor="end">
              {formatCost(xMax, null).amount}
            </text>
            <text className="s8-axis-label" x={(W + PAD.left) / 2} y={H - 6} textAnchor="middle">
              cost per task (USD)
            </text>
            <text className="s8-axis-label" x={12} y={(H - PAD.bottom) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(H - PAD.bottom) / 2})`}>
              mean score
            </text>
            {front.length > 1 && (
              <polyline
                className="s8-front-line"
                data-testid="s8-front-line"
                points={front.map((a) => `${x(a.cost_per_task as number)},${y(a.mean_score as number)}`).join(' ')}
              />
            )}
            {plotted.map((a) => {
              const cx = x(a.cost_per_task as number)
              const cy = y(a.mean_score as number)
              const kind = a.pareto.on_front ? 'front' : a.pareto.dominated ? 'dominated' : 'other'
              const cost = formatCost(a.cost_per_task, a.cost_label)
              return (
                <g key={a.agent_key} className={`s8-point s8-point--${kind}`} data-testid="s8-point" data-agent-key={a.agent_key} data-pareto={kind}>
                  <title>{`${a.model_id} (${a.harness}): mean score ${formatScore(a.mean_score)}, ${cost.amount} ${cost.label} per task, n ${a.n}, ${paretoText(a, min)}`}</title>
                  {kind === 'front' ? (
                    <rect x={cx - 6} y={cy - 6} width={12} height={12} transform={`rotate(45 ${cx} ${cy})`} />
                  ) : (
                    <circle cx={cx} cy={cy} r={6} />
                  )}
                  <text className="s8-point-label" x={cx + 9} y={cy - 8}>
                    {a.model_id}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
        <ul className="s8-legend tma-body-sm">
          <li>
            <svg width="14" height="14" aria-hidden="true" className="s8-point s8-point--front">
              <rect x="3" y="3" width="8" height="8" transform="rotate(45 7 7)" />
            </svg>{' '}
            on the Pareto front (filled diamond, joined by the line)
          </li>
          <li>
            <svg width="14" height="14" aria-hidden="true" className="s8-point s8-point--dominated">
              <circle cx="7" cy="7" r="5" />
            </svg>{' '}
            dominated (hollow dashed circle)
          </li>
        </ul>
        {skipped.length > 0 && (
          <div data-testid="s8-not-plotted">
            <p className="tma-body-sm tma-muted">Not on the chart:</p>
            <ul className="s8-skipped tma-body-sm">
              {skipped.map((a) => (
                <li key={a.agent_key} data-testid="s8-not-plotted-item" data-agent-key={a.agent_key}>
                  <span className="tma-mono">{a.model_id}</span> ({a.harness}): {notPlottedReason(a, min)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}

function AgentCell({ a }: { a: CompareAgent }) {
  const provider = providerOf(a.model_id)
  return (
    <span className="s8-agent">
      <ModelAvatar model={a.model_id} provider={provider} size={20} />
      <span>
        {provider && (
          <span className="tma-badge tma-badge--neutral s8-provider" data-testid="s8-provider">
            {provider}/
          </span>
        )}{' '}
        <span className="tma-mono">{provider ? a.model_id.slice(provider.length + 1) : a.model_id}</span>
        <span className="tma-muted tma-mono s8-key" title={a.agent_key}>
          {' '}
          #{sha12(a.agent_key.split('#')[1] ?? '')}
        </span>
        {/* TODO(C7-T5): link to the experiment page of this agent. The response has only variant ids, and S6
            (/studio/experiments) filters by agent id and case, not by variant: no link until one exists. */}
      </span>
    </span>
  )
}

function CompareTable({ data }: { data: UseCaseCompareResponse }) {
  const min = data.profile.min_runs_per_cell
  const absId = useId()
  const relId = useId()
  const rows = sortAgents(data.agents)
  return (
    <Card data-testid="s8-table">
      <CardHeader title="Agents" meta={`${rows.length} ${rows.length === 1 ? 'agent' : 'agents'}`} />
      <div className="s8-table-wrap">
        <table className="stu-table s8-table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Harness</th>
              <th scope="col">n</th>
              <th scope="col">Mean score</th>
              <th scope="col">min / p10 / p50 / p90 / max</th>
              <th scope="col">Hard-gate failures</th>
              <th scope="col">Cost per task</th>
              <th scope="col">Median wall time</th>
              <th scope="col">
                Absolute{' '}
                <span className="s8-info" tabIndex={0} title={data.rule_text.absolute} aria-describedby={absId} data-testid="s8-info-absolute">
                  ⓘ
                </span>
              </th>
              <th scope="col">
                Relative to current agent{' '}
                <span className="s8-info" tabIndex={0} title={data.rule_text.relative} aria-describedby={relId} data-testid="s8-info-relative">
                  ⓘ
                </span>
              </th>
              <th scope="col">Pareto</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const cost = formatCost(a.cost_per_task, a.cost_label)
              const d = a.distribution
              const relReason = relativeReasonText(a.relative)
              const current = data.current_agent === a.agent_key
              return (
                <tr key={a.agent_key} data-compare-row data-testid="s8-row" data-agent-key={a.agent_key} data-current={current ? 'true' : undefined}>
                  <th scope="row">
                    <AgentCell a={a} />
                    {current && <span className="tma-label s8-current-tag"> current</span>}
                  </th>
                  <td className="tma-mono">{a.harness}</td>
                  <td data-testid="s8-n">
                    <span className="tma-mono">n {a.n}</span>
                    {a.infra_error_count > 0 && <span className="tma-muted s8-sub">{a.infra_error_count} excluded (infra)</span>}
                    {a.no_score_runs > 0 && <span className="tma-muted s8-sub">{a.no_score_runs} with no score</span>}
                  </td>
                  <td className="tma-mono" data-testid="s8-mean">
                    {formatScore(a.mean_score)}
                  </td>
                  <td className="tma-mono" data-testid="s8-dist">
                    {d ? [d.min, d.p10, d.p50, d.p90, d.max].map(formatScore).join(' / ') : '—'}
                  </td>
                  <td className="tma-mono" data-testid="s8-gates">
                    {a.hard_gate_failures}
                  </td>
                  <td data-testid="s8-cost">
                    <span className="tma-mono">{cost.amount}</span>
                    {cost.label && (
                      <span className="tma-label s8-cost-label" data-cost-label={cost.label}>
                        {' '}
                        {cost.label}
                      </span>
                    )}
                  </td>
                  <td className="tma-mono">{formatWall(a.median_wall_ms)}</td>
                  <td data-testid="s8-absolute" data-label={a.absolute.label} title={data.rule_text.absolute}>
                    <span className={`s8-verdict s8-verdict--${a.absolute.label.replace(/\s+/g, '-').toLowerCase()}`}>{absoluteText(a.absolute)}</span>
                    <span className="tma-muted s8-sub">
                      ≥ {data.profile.absolute_bars.same}: {a.absolute.runs_at_least_same} of {a.n} · ≥ {data.profile.absolute_bars.close}: {a.absolute.runs_at_least_close} of {a.n}
                    </span>
                  </td>
                  <td data-testid="s8-relative" data-label={a.relative.label} title={data.rule_text.relative}>
                    <span className={`s8-verdict s8-verdict--${a.relative.label}`}>{relativeText(a.relative)}</span>
                    {a.relative.gap !== null && <span className="tma-mono s8-sub">gap {formatGap(a.relative.gap)}</span>}
                    {relReason && <span className="tma-muted s8-sub">{relReason}</span>}
                    {a.relative.mann_whitney && (
                      <span className="tma-muted tma-mono s8-sub" data-testid="s8-p">
                        Mann-Whitney p {a.relative.mann_whitney.p} ({a.relative.mann_whitney.method})
                      </span>
                    )}
                  </td>
                  <td data-testid="s8-pareto-cell" data-on-front={a.pareto.on_front === null ? undefined : String(a.pareto.on_front)}>
                    {paretoText(a, min)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <details className="stu-pad s8-rules" data-testid="s8-rules" open>
        <summary className="tma-body-sm">The two rules</summary>
        <p className="tma-body-sm" id={absId} data-testid="s8-rule-absolute">
          {data.rule_text.absolute}
        </p>
        <p className="tma-body-sm" id={relId} data-testid="s8-rule-relative">
          {data.rule_text.relative}
        </p>
      </details>
    </Card>
  )
}

function CurrentAgentSelect({ data, useCase }: { data: UseCaseCompareResponse; useCase: string }) {
  const navigate = useNavigate()
  const id = useId()
  return (
    <p className="tma-body-sm s8-current">
      <label htmlFor={id}>Current agent </label>
      <select
        id={id}
        data-testid="s8-current-select"
        value={data.current_agent ?? ''}
        onChange={(e) => navigate(studioHref('S8', { use_case: useCase, current: e.target.value }))}
      >
        <option value="">None (relative column off)</option>
        {sortAgents(data.agents).map((a) => (
          <option key={a.agent_key} value={a.agent_key}>
            {a.model_id} · {a.harness} · #{sha12(a.agent_key.split('#')[1] ?? '')}
          </option>
        ))}
      </select>
    </p>
  )
}

function KitCommand({ useCase, repeat }: { useCase: string; repeat: number }) {
  const command = caseCommands({ caseKey: '<case key>', useCaseKey: useCase, mode: 'run' }, { repeat }).join('\n')
  return <CopyCommand title="Get more samples for a cell with the kit:" testId="s8-copy-command" command={command} />
}

export function CompareView({ data, useCase }: { data: UseCaseCompareResponse; useCase: string }) {
  if (data.agents.length === 0) {
    return (
      <div className="stu-groups">
        <Card pad data-testid="s8-empty">
          <span className="tma-label">No samples</span>
          <p className="tma-body-sm tma-muted">No runs for this use case yet.</p>
        </Card>
        <Card pad>
          <KitCommand useCase={useCase} repeat={data.profile.min_runs_per_cell} />
        </Card>
      </div>
    )
  }
  return (
    <div className="stu-groups">
      <ProfileNotice profile={data.profile} />
      <CurrentAgentSelect data={data} useCase={useCase} />
      <ParetoChart data={data} />
      <CompareTable data={data} />
      <Card pad>
        <p className="tma-body-sm">
          <Link to={routingHref(useCase)} data-testid="s8-routing-link">
            Routing for this use case
          </Link>
        </p>
      </Card>
      <Card pad>
        <KitCommand useCase={useCase} repeat={data.profile.min_runs_per_cell} />
      </Card>
    </div>
  )
}

/** The L1 pairs of the caller's test cases, with a case count, sorted by name. */
export function useCasePairs(cases: readonly StudioCase[]): Array<{ key: string; count: number }> {
  const by = new Map<string, number>()
  for (const c of cases) if (isL1Pair(c.useCaseKey)) by.set(c.useCaseKey, (by.get(c.useCaseKey) ?? 0) + 1)
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => ({ key, count }))
}

function UseCasePicker({ cases }: { cases?: StudioCase[] }) {
  const loaded = useStudioLoad(cases ? null : () => api.evalCases().then((r) => r.cases as StudioCase[]), [cases ? 'prop' : 'api'])
  const list = cases ?? (loaded.state === 'ok' ? loaded.data : null)
  if (!list) {
    return loaded.state === 'error' ? (
      <Card pad data-testid="s8-picker-empty">
        <p className="tma-body-sm tma-muted" data-testid="s8-load-error">
          {loadErrorText(loaded.status)}
        </p>
      </Card>
    ) : (
      <Card pad data-testid="s8-loading">
        <span className="tma-body-sm tma-muted">Loading use cases…</span>
      </Card>
    )
  }
  const pairs = useCasePairs(list)
  if (pairs.length === 0) {
    return (
      <Card pad data-testid="s8-picker-empty">
        <span className="tma-label">No use cases yet</span>
        <p className="tma-body-sm tma-muted">A use case appears here when one of your test cases has a taxonomy pair type/subtype.</p>
      </Card>
    )
  }
  return (
    <Card data-testid="s8-picker">
      <CardHeader title="Use cases" meta={`${pairs.length} ${pairs.length === 1 ? 'pair' : 'pairs'}`} />
      <ul className="stu-cases stu-pad">
        {pairs.map((p) => (
          <li key={p.key} className="tma-mono">
            <Link to={studioHref('S8', { use_case: p.key })} data-testid="s8-use-case-link" data-use-case={p.key}>
              {p.key}
            </Link>
            <span className="tma-muted stu-count">
              {' '}
              · {p.count} {p.count === 1 ? 'case' : 'cases'}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function errorText(status: number, message: string): string {
  if (status === 400 && message === 'unknown_current_agent') return 'The current agent in the address has no runs in this use case.'
  if (status === 400) return 'This is not a use case pair. A use case is one taxonomy pair type/subtype, for example fix/prod-bug.'
  if (status === 503) return 'The compare view is not available yet: the result store is not migrated on this server.'
  return loadErrorText(status)
}

export function StudioComparePage({ data, cases }: { data?: UseCaseCompareResponse; cases?: StudioCase[] }) {
  const [params] = useSearchParams()
  const useCase = params.get('use_case')
  const current = params.get('current')
  const loaded = useStudioLoad(data || !useCase ? null : () => getUseCaseCompare(useCase, current), [data ? 'prop' : 'api', useCase, current])
  const shown = data ?? (loaded.state === 'ok' ? loaded.data : null)
  return (
    <main className="tma-page" data-testid="studio-compare">
      <div className="stu-head">
        <p className="tma-body-sm">
          <Link to="/studio">Studio</Link> / {useCase ? <Link to="/studio/compare">compare</Link> : 'compare'}
          {useCase && <> / {useCase}</>}
        </p>
        <h1 className="tma-h1">{useCase ? <span className="tma-mono">{useCase}</span> : 'Compare agents per use case'}</h1>
        <p className="stu-sub">
          Agents on the same use case, from your uploaded results: score, cost and both verdicts side by side. Read only.
        </p>
      </div>
      {!useCase ? (
        <UseCasePicker cases={cases} />
      ) : shown ? (
        <CompareView data={shown} useCase={useCase} />
      ) : loaded.state === 'error' ? (
        <Card pad data-testid="s8-error" data-status={loaded.status}>
          <span className="tma-label">No comparison</span>
          <p className="tma-body-sm tma-muted" data-testid="s8-load-error">
            {errorText(loaded.status, loaded.message)}
          </p>
          {loaded.status === 400 && (
            <p className="tma-body-sm">
              <Link to={current ? studioHref('S8', { use_case: useCase }) : '/studio/compare'}>
                {current ? 'Show this use case with no current agent' : 'Show the use cases'}
              </Link>
            </p>
          )}
        </Card>
      ) : (
        <Card pad data-testid="s8-loading">
          <span className="tma-body-sm tma-muted">Loading the comparison…</span>
        </Card>
      )}
    </main>
  )
}
