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
 *
 * Layout (redesign C5-RD-S8, canvas artboard "S8 Agent compare"): a trail bar (use case, agents, runs; the current
 * agent select and the score profile at the right), the title, the score-vs-cost chart (log cost axis), the agent table, and at the right
 * the panel "Our suggestion": the C7 recommendation of routing.ts (the cheapest agent that passes a rule with n >= 5;
 * it reads the API labels, it computes no verdict) and a link to S12, where a person proposes the route. The
 * artboard's Weighted / All-or-nothing toggle shows the one profile the API sent: the UI never rescores (ADR-7).
 */
import { useId, useMemo, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { Card, CardHeader } from '../tma/ui'
import { Crumb, CrumbSep, InfoTip, StudioBar, TitleRow } from './chrome'
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
import { agentHref, routingHref, studioHref } from './links'
import { recommendAgent } from './routing'
import { themeClass } from './theme'
import { isL1Pair, type StudioCase } from './use-case'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'
import './compare-page.css'

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

const W = 1000
const H = 320
const PAD = { left: 56, right: 140, top: 24, bottom: 40 }

/** The cost axis: log10 between the powers of ten around the plotted costs (a linear axis hides the cheap agents). */
export function costAxis(costs: readonly number[]): { lo: number; hi: number; ticks: number[] } {
  const pos = costs.filter((c) => c > 0)
  if (!pos.length) return { lo: 0.001, hi: 1, ticks: [0.001, 0.01, 0.1, 1] }
  let lo = Math.floor(Math.log10(Math.min(...pos)))
  let hi = Math.ceil(Math.log10(Math.max(...pos)))
  // At least three decades: grow toward $1 first, then down.
  while (hi - lo < 3) {
    if (hi < 0) hi++
    else lo--
  }
  const ticks: number[] = []
  for (let e = lo; e <= hi; e++) ticks.push(Number((10 ** e).toPrecision(1)))
  return { lo: 10 ** lo, hi: 10 ** hi, ticks }
}

/** The score axis: from the 20-point step under the lowest plotted score (at most 40) up to 100. */
export function scoreFloor(scores: readonly number[]): number {
  if (!scores.length) return 40
  return Math.max(0, Math.min(40, Math.floor(Math.min(...scores) / 20) * 20))
}

const tickText = (c: number) => (c >= 1 ? `$${c}` : `$${c.toFixed(Math.max(2, -Math.floor(Math.log10(c))))}`)

/** Inline SVG Pareto chart: mean score (Y) over cost per task (X, log). Front vs dominated by shape and stroke, not colour. */
export function ParetoChart({ data }: { data: UseCaseCompareResponse }) {
  const min = data.profile.min_runs_per_cell
  const plotted = data.agents.filter((a) => notPlottedReason(a, min) === null)
  const skipped = data.agents.filter((a) => notPlottedReason(a, min) !== null)
  const axis = costAxis(plotted.map((a) => a.cost_per_task as number))
  const floor = scoreFloor(plotted.map((a) => a.mean_score as number))
  const lx = (c: number) => Math.log10(Math.max(c, axis.lo))
  const x = (c: number) => PAD.left + ((lx(c) - Math.log10(axis.lo)) / (Math.log10(axis.hi) - Math.log10(axis.lo))) * (W - PAD.left - PAD.right)
  const y = (s: number) => PAD.top + (1 - (s - floor) / (100 - floor)) * (H - PAD.top - PAD.bottom)
  const front = plotted.filter((a) => a.pareto.on_front).sort((a, b) => (a.cost_per_task as number) - (b.cost_per_task as number))
  const yTicks: number[] = []
  for (let t = floor; t <= 100; t += 20) yTicks.push(t)
  return (
    <section className="s8-chart-sec" data-testid="s8-pareto">
      <h2 className="s8-h2">
        Score vs cost per task{' '}
        <span className="s8-h2__meta">
          {plotted.length} of {data.agents.length} agents plotted
        </span>
      </h2>
      <div className="s8-chart-box">
        <svg
          className="s8-chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Mean score over cost per task for ${plotted.length} agents. ${front.length} on the Pareto front.`}
          data-testid="s8-pareto-svg"
        >
          {yTicks.map((t) => (
            <g key={t}>
              {t > floor && t < 100 && <line className="s8-grid" x1={PAD.left} y1={y(t)} x2={W - PAD.right} y2={y(t)} />}
              <text className="s8-tick" x={PAD.left - 12} y={y(t) + 4} textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          <line className="s8-axis" x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} />
          <line className="s8-axis" x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} />
          {axis.ticks.map((t, i) => (
            <text key={t} className="s8-tick" x={x(t)} y={H - PAD.bottom + 18} textAnchor={i === 0 ? 'start' : i === axis.ticks.length - 1 ? 'end' : 'middle'}>
              {tickText(t)}
            </text>
          ))}
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
            const label = `${a.model_id.replace(/^.*\//, '')} · ${formatScore(a.mean_score)}`
            return (
              <g key={a.agent_key} className={`s8-point s8-point--${kind}`} data-testid="s8-point" data-agent-key={a.agent_key} data-pareto={kind}>
                <title>{`${label}: ${a.model_id} (${a.harness}), ${cost.amount} ${cost.label} per task, n ${a.n}, ${paretoText(a, min)}`}</title>
                {kind === 'front' ? <rect x={cx - 5} y={cy - 5} width={10} height={10} transform={`rotate(45 ${cx} ${cy})`} /> : <circle cx={cx} cy={cy} r={5} />}
                <text className="s8-point-label" x={cx + 10} y={cy + 14}>
                  {label}
                </text>
              </g>
            )
          })}
          {plotted.length === 0 && (
            <text className="s8-chart-empty" x={(W + PAD.left - PAD.right) / 2} y={(H - PAD.bottom) / 2} textAnchor="middle" data-testid="s8-chart-empty">
              No agent has a full, priced cell yet: the list under the chart says why.
            </text>
          )}
        </svg>
        <ul className="s8-legend">
          <li>
            <svg width="12" height="12" aria-hidden="true" className="s8-point s8-point--front">
              <rect x="2.5" y="2.5" width="7" height="7" transform="rotate(45 6 6)" />
            </svg>
            on the Pareto front
          </li>
          <li>
            <svg width="12" height="12" aria-hidden="true" className="s8-point s8-point--dominated">
              <circle cx="6" cy="6" r="4" />
            </svg>
            dominated
          </li>
          <li className="s8-legend__axis">cost per task, log scale · mean score 0-100</li>
        </ul>
        {skipped.length > 0 && (
          <div className="s8-skipped" data-testid="s8-not-plotted">
            <span className="s8-skipped__head">not on the chart</span>
            <ul>
              {skipped.map((a) => (
                <li key={a.agent_key} data-testid="s8-not-plotted-item" data-agent-key={a.agent_key}>
                  <span className="tma-mono">{a.model_id}</span> ({a.harness}): {notPlottedReason(a, min)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

/** variant id -> the web2 agent that ran it (from GET /eval-runs). The compare response has variant ids but no agent id. */
type AgentOf = Map<string, { id: string; name: string | null }>

const letters = (h: string) => (/claude/i.test(h) ? 'CC' : /codex/i.test(h) ? 'CX' : /opencode/i.test(h) ? 'OC' : h.slice(0, 2).toUpperCase())
const ground = (h: string) => (/claude/i.test(h) ? 'cc' : /codex/i.test(h) ? 'cx' : /opencode/i.test(h) ? 'oc' : 'al')

/** The canvas agent tile: harness letters on their ground, the model's first letter at the corner. */
function AgentTile({ a, big }: { a: CompareAgent; big?: boolean }) {
  return (
    <span className={`s8-tile${big ? ' s8-tile--big' : ''}`} aria-hidden="true">
      <span className={`s8-tile__ground s8-tile__ground--${ground(a.harness)}`}>{letters(a.harness)}</span>
      <span className="s8-tile__badge">{(a.model_id.replace(/^.*\//, '')[0] ?? '?').toUpperCase()}</span>
    </span>
  )
}

function AgentCell({ a, agentOf }: { a: CompareAgent; agentOf?: AgentOf }) {
  const provider = providerOf(a.model_id)
  const owner = a.variant_ids.map((v) => agentOf?.get(v)).find((x) => !!x)
  return (
    <span className="s8-agent">
      <AgentTile a={a} />
      <span className="s8-agent__text">
        <span>
          <span className="s8-agent__harness">{a.harness}</span> · {provider ? a.model_id.slice(provider.length + 1) : a.model_id}
        </span>
        <span className="s8-agent__meta">
          {provider && (
            <span className="s8-provider" data-testid="s8-provider">
              {provider}/
            </span>
          )}
          <span className="s8-key" title={a.agent_key}>
            #{sha12(a.agent_key.split('#')[1] ?? '')}
          </span>
          {owner && (
            <Link to={agentHref(owner.id)} className="s8-agent-link" data-testid="s8-agent-link">
              Agent page{owner.name ? `: ${owner.name}` : ''}
            </Link>
          )}
        </span>
      </span>
    </span>
  )
}

/** "held / n" from the response counts (display only: hard_gate_failures counts the scored runs that failed a must-pass check). */
export const gatesHeld = (a: Pick<CompareAgent, 'n' | 'hard_gate_failures'>): string =>
  a.hard_gate_failures <= a.n ? `${a.n - a.hard_gate_failures} / ${a.n}` : `${a.hard_gate_failures} failed`

function Bar({ value, max }: { value: number | null; max: number }) {
  if (value === null || !(max > 0)) return null
  return (
    <span className="s8-bar" aria-hidden="true">
      <span className="s8-bar__fill" style={{ width: `${Math.max(2, Math.round((value / max) * 100))}%` }} />
    </span>
  )
}

function VerdictIcon({ label }: { label: string }) {
  const tone = /^(SAME|better|tie)$/.test(label) ? 'ok' : /^(CLOSE)$/.test(label) ? 'warn' : /^(NOT YET|worse)$/.test(label) ? 'bad' : 'none'
  return (
    <svg className={`s8-vicon s8-vicon--${tone}`} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      {tone === 'ok' && <path d="m8 12 3 3 5-6" />}
      {tone === 'warn' && <path d="M8 10h8M8 14h8" />}
      {tone === 'bad' && <path d="m9 9 6 6M15 9l-6 6" />}
      {tone === 'none' && <path d="M8 12h8" />}
    </svg>
  )
}

function CompareTable({ data, agentOf, suggested }: { data: UseCaseCompareResponse; agentOf?: AgentOf; suggested: string | null }) {
  const min = data.profile.min_runs_per_cell
  const absId = useId()
  const relId = useId()
  const rows = sortAgents(data.agents)
  const maxCost = Math.max(0, ...rows.map((a) => a.cost_per_task ?? 0))
  const maxWall = Math.max(0, ...rows.map((a) => a.median_wall_ms ?? 0))
  return (
    <section data-testid="s8-table">
      <div className="s8-table-wrap">
        <table className="s8-table">
          <thead>
            <tr>
              <th scope="col">agent</th>
              <th scope="col" className="s8-num">
                score
              </th>
              <th scope="col" className="s8-num">
                gates held
              </th>
              <th scope="col" className="s8-num">
                cost / task
              </th>
              <th scope="col" className="s8-num">
                wall time
              </th>
              <th scope="col" className="s8-num">
                runs
              </th>
              <th scope="col">
                verdict{' '}
                <span className="s8-info" tabIndex={0} title={data.rule_text.absolute} aria-describedby={absId} data-testid="s8-info-absolute">
                  ⓘ
                </span>
              </th>
              <th scope="col">
                vs current agent{' '}
                <span className="s8-info" tabIndex={0} title={data.rule_text.relative} aria-describedby={relId} data-testid="s8-info-relative">
                  ⓘ
                </span>
              </th>
              <th scope="col">pareto</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const cost = formatCost(a.cost_per_task, a.cost_label)
              const d = a.distribution
              const relReason = relativeReasonText(a.relative)
              const current = data.current_agent === a.agent_key
              return (
                <tr
                  key={a.agent_key}
                  className={a.agent_key === suggested ? 's8-row--suggested' : undefined}
                  data-compare-row
                  data-testid="s8-row"
                  data-agent-key={a.agent_key}
                  data-current={current ? 'true' : undefined}
                  data-suggested={a.agent_key === suggested ? 'true' : undefined}
                >
                  <th scope="row">
                    <AgentCell a={a} agentOf={agentOf} />
                    {current && <span className="s8-current-tag"> current</span>}
                  </th>
                  <td className="s8-num">
                    <span className="s8-strong" data-testid="s8-mean">
                      {formatScore(a.mean_score)}
                    </span>
                    <span className="s8-sub s8-mono" data-testid="s8-dist" title="min / p10 / p50 / p90 / max">
                      {d ? [d.min, d.p10, d.p50, d.p90, d.max].map(formatScore).join(' / ') : '—'}
                    </span>
                  </td>
                  <td className={`s8-num${a.hard_gate_failures > 0 ? ' s8-bad' : ''}`} data-testid="s8-gates" data-failures={a.hard_gate_failures}>
                    {gatesHeld(a)}
                  </td>
                  <td className="s8-num" data-testid="s8-cost">
                    <span className="s8-strong">{cost.amount}</span>
                    {cost.label && (
                      <span className="s8-sub s8-cost-label" data-cost-label={cost.label}>
                        {' '}
                        {cost.label}
                      </span>
                    )}
                    <Bar value={a.cost_per_task} max={maxCost} />
                  </td>
                  <td className="s8-num">
                    <span className="s8-strong">{formatWall(a.median_wall_ms)}</span>
                    <Bar value={a.median_wall_ms} max={maxWall} />
                  </td>
                  <td className="s8-num" data-testid="s8-n">
                    <span className="s8-strong">n {a.n}</span>
                    {a.infra_error_count > 0 && <span className="s8-sub">{a.infra_error_count} excluded (infra)</span>}
                    {a.no_score_runs > 0 && <span className="s8-sub">{a.no_score_runs} with no score</span>}
                  </td>
                  <td data-testid="s8-absolute" data-label={a.absolute.label} title={data.rule_text.absolute}>
                    <span className={`s8-verdict s8-verdict--${a.absolute.label.replace(/\s+/g, '-').toLowerCase()}`}>
                      <VerdictIcon label={a.absolute.label} />
                      {absoluteText(a.absolute)}
                    </span>
                    <span className="s8-sub">
                      ≥ {data.profile.absolute_bars.same}: {a.absolute.runs_at_least_same} of {a.n} · ≥ {data.profile.absolute_bars.close}: {a.absolute.runs_at_least_close} of {a.n}
                    </span>
                  </td>
                  <td data-testid="s8-relative" data-label={a.relative.label} title={data.rule_text.relative}>
                    <span className={`s8-verdict s8-verdict--${a.relative.label}`}>
                      <VerdictIcon label={a.relative.label} />
                      {relativeText(a.relative)}
                    </span>
                    {a.relative.gap !== null && <span className="s8-sub s8-mono">gap {formatGap(a.relative.gap)}</span>}
                    {relReason && <span className="s8-sub">{relReason}</span>}
                    {a.relative.mann_whitney && (
                      <span className="s8-sub s8-mono" data-testid="s8-p">
                        Mann-Whitney p {a.relative.mann_whitney.p} ({a.relative.mann_whitney.method})
                      </span>
                    )}
                  </td>
                  <td className="s8-pareto" data-testid="s8-pareto-cell" data-on-front={a.pareto.on_front === null ? undefined : String(a.pareto.on_front)}>
                    {paretoText(a, min)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <details className="s8-rules" data-testid="s8-rules">
        <summary>The two verdict rules</summary>
        <p id={absId} data-testid="s8-rule-absolute">
          {data.rule_text.absolute}
        </p>
        <p id={relId} data-testid="s8-rule-relative">
          {data.rule_text.relative}
        </p>
      </details>
    </section>
  )
}

function CurrentAgentSelect({ data, useCase }: { data: UseCaseCompareResponse; useCase: string }) {
  const navigate = useNavigate()
  const id = useId()
  return (
    <span className="s8-current">
      <label htmlFor={id}>Current agent</label>
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
    </span>
  )
}

/**
 * The canvas Score control. The API sends ONE score profile (ADR-7: the UI never rescores), so the control shows which
 * one it is: "Weighted" is on (each run's stored grader weights, or a pinned profile's weights). "All-or-nothing" is
 * shown off and disabled, with the reason, until the API sends such a profile.
 */
function ScoreProfile({ profile }: { profile: Profile }) {
  const allOrNothing = /all.?or.?nothing/i.test(profile.weights)
  const off = 'The API sends one score profile per use case; the studio never rescores the runs.'
  return (
    <span className="s8-score" role="radiogroup" aria-label="Score" data-testid="s8-score-profile">
      <span className="s8-score__label">Score</span>
      <label className="s8-seg" title={allOrNothing ? off : `Weights: ${profile.weights}`}>
        <input type="radio" name="s8-score" checked={!allOrNothing} disabled={allOrNothing} readOnly />
        Weighted
      </label>
      <label className="s8-seg" title={allOrNothing ? `Weights: ${profile.weights}` : off}>
        <input type="radio" name="s8-score" checked={allOrNothing} disabled={!allOrNothing} readOnly />
        All-or-nothing
      </label>
    </span>
  )
}

function KitCommand({ useCase, repeat }: { useCase: string; repeat: number }) {
  const command = caseCommands({ caseKey: '<case key>', useCaseKey: useCase, mode: 'run' }, { repeat }).join('\n')
  return <CopyCommand title="More samples for a cell, with the kit" testId="s8-copy-command" command={command} />
}

const verdictWords = (a: CompareAgent, rules: string[]): string =>
  rules.map((r) => (r === 'absolute' ? `${absoluteText(a.absolute)} (absolute rule)` : `${relativeText(a.relative)} vs the current agent`)).join(' and ')

/** The right panel: the C7 recommendation (routing.ts, from the API labels), the S12 link, the profile, the kit. */
function SuggestionPanel({ data, useCase }: { data: UseCaseCompareResponse; useCase: string }) {
  const rec = recommendAgent(data.agents)
  const current = data.current_agent ? (data.agents.find((a) => a.agent_key === data.current_agent) ?? null) : null
  const vsCurrent = rec && current && current.agent_key !== rec.agent.agent_key ? current : null
  const a = rec?.agent ?? null
  return (
    <aside className="s8-side" aria-label="Our suggestion" data-testid="s8-suggestion">
      <section className="s8-side__sec">
        <h2 className="s8-side__kicker">Our suggestion</h2>
        {a && rec ? (
          <>
            <p className="s8-side__agent">
              <AgentTile a={a} big />
              <span>
                {a.harness} · {a.model_id.replace(/^.*\//, '')}
              </span>
            </p>
            <p className="s8-side__lead" data-testid="s8-suggestion-text">
              The cheapest agent with a passing verdict and at least {data.profile.min_runs_per_cell} runs: <b>{verdictWords(a, rec.rules)}</b>, over <b>{a.n} runs</b>
              {a.hard_gate_failures === 0 ? ', and it never broke a must-pass check.' : '.'}
            </p>
            <dl className="s8-facts" data-testid="s8-suggestion-facts">
              <dt>Cost per task</dt>
              <dd>
                {vsCurrent && vsCurrent.cost_per_task !== null && <s className="s8-was">{formatCost(vsCurrent.cost_per_task, null).amount}</s>} {formatCost(a.cost_per_task, a.cost_label).amount}
              </dd>
              <dt>Score</dt>
              <dd>
                {formatScore(a.mean_score)}
                {vsCurrent && <span className="s8-vs"> vs {formatScore(vsCurrent.mean_score)}</span>}
              </dd>
              <dt>Must-pass checks</dt>
              <dd className={a.hard_gate_failures === 0 ? 's8-good' : 's8-bad'}>{a.hard_gate_failures === 0 ? 'all held' : `${a.hard_gate_failures} failed`}</dd>
            </dl>
          </>
        ) : (
          <p className="s8-side__lead" data-testid="s8-suggestion-none">
            No suggestion yet. No agent holds a passing verdict with at least {data.profile.min_runs_per_cell} runs. Add samples with the kit below.
          </p>
        )}
        <Link to={routingHref(useCase)} className={a ? 's8-primary' : 's8-secondary'} data-testid="s8-routing-link">
          {a ? 'Propose this agent as the route' : 'Open routing for this use case'}
        </Link>
      </section>
      <section className="s8-side__sec">
        <KitCommand useCase={useCase} repeat={data.profile.min_runs_per_cell} />
      </section>
      <details className="s8-side__tech">
        <summary>Score profile</summary>
        <ProfileNotice profile={data.profile} />
      </details>
    </aside>
  )
}

export function CompareView({ data, useCase, agentOf }: { data: UseCaseCompareResponse; useCase: string; agentOf?: AgentOf }) {
  const suggested = recommendAgent(data.agents)?.agent.agent_key ?? null
  if (data.agents.length === 0) {
    return (
      <div className="s8-layout">
        <div className="stu-body s8-main">
          <Title />
          <div className="s8-empty" data-testid="s8-empty">
            <span className="tma-label">No samples</span>
            <p className="tma-body-sm tma-muted">No runs for this use case yet.</p>
          </div>
        </div>
        <aside className="s8-side" aria-label="Get samples">
          <KitCommand useCase={useCase} repeat={data.profile.min_runs_per_cell} />
        </aside>
      </div>
    )
  }
  return (
    <div className="s8-layout">
      <div className="stu-body s8-main">
        <Title />
        <ParetoChart data={data} />
        <CompareTable data={data} agentOf={agentOf} suggested={suggested} />
      </div>
      <SuggestionPanel data={data} useCase={useCase} />
    </div>
  )
}

const COMPARE_TIP =
  'Agents on the same use case, from your uploaded results. The API gives each agent its score, cost and both verdicts: the absolute rule (SAME, CLOSE, NOT YET) and the relative rule (better, same, worse than the current agent). Read only.'

function Title({ children }: { children?: ReactNode }) {
  return (
    <TitleRow tip={<InfoTip label="About agent compare" text={COMPARE_TIP} />}>
      <h1 className="tma-h1">{children ?? 'Agent compare'}</h1>
    </TitleRow>
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
  // Best effort: a failed read only leaves the per-agent links out. It never changes the verdicts of the table.
  const runs = useStudioLoad(shown ? () => api.evalRuns({}) : null, [shown ? useCase : null, current])
  const agentOf = useMemo<AgentOf | undefined>(() => {
    if (runs.state !== 'ok') return undefined
    const m: AgentOf = new Map()
    for (const r of runs.data.runs) if (r.agentId) m.set(r.variant.id, { id: r.agentId, name: r.agentName })
    return m
  }, [runs])
  const totalRuns = shown ? shown.agents.reduce((n, a) => n + a.n, 0) : 0
  return (
    <main className={themeClass('tma-page', 'stu-page', 's8-page')} data-testid="studio-compare">
      <StudioBar
        trail={
          <>
            <Link to="/studio" data-testid="studio-back">
              Studio
            </Link>
            <CrumbSep />
            {useCase ? <Link to="/studio/compare">agent compare</Link> : <Crumb current>agent compare</Crumb>}
            {useCase && (
              <>
                <CrumbSep />
                <Crumb current>
                  <span data-testid="s8-use-case">{useCase}</span>
                </Crumb>
                {shown && (
                  <span className="s8-trail-meta" data-testid="s8-trail-meta">
                    {shown.agents.length} {shown.agents.length === 1 ? 'agent' : 'agents'} · {totalRuns} runs
                  </span>
                )}
              </>
            )}
          </>
        }
        actions={
          useCase && shown && shown.agents.length > 0 ? (
            <>
              <ScoreProfile profile={shown.profile} />
              <CurrentAgentSelect data={shown} useCase={useCase} />
            </>
          ) : undefined
        }
      />
      {!useCase ? (
        <div className="stu-body">
          <Title />
          <UseCasePicker cases={cases} />
        </div>
      ) : shown ? (
        <CompareView data={shown} useCase={useCase} agentOf={agentOf} />
      ) : loaded.state === 'error' ? (
        <div className="stu-body">
          <Title />
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
        </div>
      ) : (
        <div className="stu-body">
          <Title />
          <p className="tma-body-sm tma-muted" data-testid="s8-loading">
            Loading the comparison…
          </p>
        </div>
      )}
    </main>
  )
}
