/**
 * S12 Routing per use case (plan 20261112-tma-c8-routing-from-evals, task C8-T3), route /studio/routing/:useCase
 * (the L1 pair type/subtype, URL-encoded). Reached from S8.
 *
 *   current route    the latest `live` row of GET /routes?use_case=, or "default (no live route)"; with tma-route/2 rows
 *                    also "live since <date>" (live_at) and the rollback PR link (rollback_pr_url) when present.
 *   recommendation   the cheapest agent with a passing verdict under either rule and n >= 5 (recommendAgent, from the
 *                    S8 compare response; no verdict is computed here).
 *   the agent        both verdicts side by side (as S8 shows them), n, cost per task with its label, the evidence runs
 *                    as links to /evaluations/:eid, the policy version. The evidence list is the compare response's
 *                    `evidence_run_ids` (plan C8, Q4 = A): exactly the runs POST /routes/approve freezes for the picked
 *                    rule (under relative, plus the current agent's), joined to GET /eval-runs only for the link; an
 *                    id with no eval-runs row is listed unlinked. An older API without the field: the runs of the
 *                    agent's variants from GET /eval-runs (an approximation).
 *   one action       "Pick rule and approve": POST /routes/approve. The row it writes is the verdict only (ADR-1); the
 *                    change itself goes by a PR that the kit command `tma route pr` opens (copy command).
 *   swap pending     a route row in state approved with a pr_url (isSwapPending, Q d881e5df = C) shows the applied route
 *                    it would replace, its PR, and "Approve swap" / "Reject swap" (POST /routes/:id/swap); after an
 *                    answer the routes reload. Only a person's own login may decide (Q b5c4ba38 = B): a 403
 *                    not_a_human_actor shows NOT_A_HUMAN_TEXT, also on the approve-route control.
 *
 * The compare request uses the agent of the live route as the current agent (so the relative rule compares with
 * what is live today), unless ?current=<agent key> names another one.
 * The `data` prop is a test seam.
 */
import { useId, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import type { EvalRun } from '../lib/api/types'
import { Card, CardHeader } from '../tma/ui'
import { absoluteText, formatCost, formatScore, getUseCaseCompare, relativeText, sha12, sortAgents, type CompareAgent, type UseCaseCompareResponse } from './compare'
import { CopyCommand } from './CopyCommand'
import { caseCommands } from './eval-command'
import { studioHref } from './links'
import {
  appliedRouteFor,
  approveBlockers,
  approveBody,
  getRoutes,
  isSwapPending,
  NOT_A_HUMAN_TEXT,
  postSwapDecision,
  type SwapDecision,
  latestLive,
  passesUnder,
  postApproveRoute,
  recommendAgent,
  evidenceIdsOf,
  routeAgentKey,
  routePrCommand,
  ROUTING_MIN_N,
  splitTarget,
  targetProblems,
  type Route,
  type RouteRule,
  type TargetInput,
  type TargetKind,
} from './routing'
import { evaluationHref } from './runs'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

export interface RoutingData {
  compare: UseCaseCompareResponse
  /** Null when GET /routes failed (for example 503 before the routes migration). */
  routes: Route[] | null
  routesError?: number | null
  /** The caller's runs (GET /eval-runs), for the evidence links; null when that call failed. */
  runs: EvalRun[] | null
}

/** The 403 of a login that is not a person's own (Q b5c4ba38 = B). */
const isNotHuman = (e: unknown) => e instanceof ApiError && e.status === 403 && e.message === 'not_a_human_actor'

/** One line for a failed POST: the human-login text for a 403 not_a_human_actor, else the API message (and code). */
function postErrorText(e: unknown): string {
  if (isNotHuman(e)) return NOT_A_HUMAN_TEXT
  const msg = e instanceof ApiError ? ((e.body as { message?: string } | undefined)?.message ?? e.message) : 'The request failed. Try again.'
  const code = e instanceof ApiError ? e.message : null
  return code && code !== msg ? `${msg} (${code})` : msg
}

const isUnknownCurrent = (e: unknown) => e instanceof ApiError && e.status === 400 && e.message === 'unknown_current_agent'

/** Loads the three sources. A live agent that is not in the caller's runs falls back to "no current agent". */
export async function loadRouting(useCase: string, currentParam: string | null): Promise<RoutingData> {
  let routes: Route[] | null = null
  let routesError: number | null = null
  try {
    routes = (await getRoutes(useCase)).routes
  } catch (e) {
    routesError = e instanceof ApiError ? e.status : 0
  }
  const live = routes ? latestLive(routes) : null
  const current = currentParam ?? (live ? routeAgentKey(live) : null)
  let compare: UseCaseCompareResponse
  try {
    compare = await getUseCaseCompare(useCase, current)
  } catch (e) {
    if (!currentParam && current && isUnknownCurrent(e)) compare = await getUseCaseCompare(useCase, null)
    else throw e
  }
  const runs = await api.evalRuns().then(
    (r) => r.runs,
    () => null,
  )
  return { compare, routes, routesError, runs }
}

const agentLabel = (a: { model_id: string; harness?: string | null }, key: string) =>
  `${a.model_id}${a.harness ? ` · ${a.harness}` : ''} · #${sha12(key.split('#')[1] ?? '')}`

function MoreSamples({ useCase, n }: { useCase: string; n: number }) {
  const repeat = Math.min(10, Math.max(1, ROUTING_MIN_N - n))
  const command = caseCommands({ caseKey: '<case key>', useCaseKey: useCase, mode: 'run' }, { repeat }).join('\n')
  return <CopyCommand title={`Ask for ${repeat} more samples of this cell with the kit:`} testId="s12-more-samples" command={command} />
}

function CurrentRoute({ live, routesError }: { live: Route | null; routesError: number | null }) {
  return (
    <Card data-testid="s12-current" data-state={live ? 'live' : 'default'}>
      <CardHeader title="Current route" meta={live ? 'live' : undefined} />
      <div className="stu-pad">
        {routesError ? (
          <p className="tma-body-sm tma-muted" data-testid="s12-routes-error">
            {routesError === 503 ? 'Routes are not available yet: the route store is not migrated on this server.' : loadErrorText(routesError)}
          </p>
        ) : live ? (
          <dl className="stu-summary s12-dl">
            <dt>Agent</dt>
            <dd className="tma-mono">{agentLabel(live, routeAgentKey(live))}</dd>
            <dt>Target</dt>
            <dd className="tma-mono">
              {live.route_target} = {live.target_value}
            </dd>
            <dt>Verdict</dt>
            <dd>
              {live.verdict} under the {live.picked_rule} rule, n {live.n}
            </dd>
            <dt>Policy</dt>
            <dd className="tma-mono">{live.policy_version}</dd>
            {live.pr_url && (
              <>
                <dt>PR</dt>
                <dd>
                  <a href={live.pr_url} target="_blank" rel="noreferrer" data-testid="s12-pr-link">
                    {live.pr_url}
                  </a>
                </dd>
              </>
            )}
            {live.live_at && (
              <>
                <dt>Live</dt>
                <dd data-testid="s12-live-since" title={live.live_at}>
                  live since {live.live_at.slice(0, 10)}
                </dd>
              </>
            )}
            {live.rollback_pr_url && (
              <>
                <dt>Rollback PR</dt>
                <dd>
                  <a href={live.rollback_pr_url} target="_blank" rel="noreferrer" data-testid="s12-rollback-pr-link">
                    {live.rollback_pr_url}
                  </a>
                </dd>
              </>
            )}
          </dl>
        ) : (
          <p className="tma-body-sm">default (no live route)</p>
        )}
      </div>
    </Card>
  )
}

function Verdicts({ a, data }: { a: CompareAgent; data: UseCaseCompareResponse }) {
  return (
    <div className="s12-verdicts">
      <div className="s12-verdict-box" data-testid="s12-verdict-absolute" data-label={a.absolute.label} data-passes={String(passesUnder(a, 'absolute'))} title={data.rule_text.absolute}>
        <span className="tma-label">Absolute</span>
        <span className={`s8-verdict s8-verdict--${a.absolute.label.replace(/\s+/g, '-').toLowerCase()}`}>{absoluteText(a.absolute)}</span>
        <span className="tma-muted s8-sub">
          ≥ {data.profile.absolute_bars.same}: {a.absolute.runs_at_least_same} of {a.n} · ≥ {data.profile.absolute_bars.close}: {a.absolute.runs_at_least_close} of {a.n}
        </span>
      </div>
      <div className="s12-verdict-box" data-testid="s12-verdict-relative" data-label={a.relative.label} data-passes={String(passesUnder(a, 'relative'))} title={data.rule_text.relative}>
        <span className="tma-label">Relative to current agent</span>
        <span className={`s8-verdict s8-verdict--${a.relative.label}`}>{relativeText(a.relative)}</span>
        {data.current_agent && <span className="tma-muted tma-mono s8-sub">vs {sha12(data.current_agent.split('#')[1] ?? '')}</span>}
      </div>
    </div>
  )
}

function Evidence({ a, data, rule, runs, useCase }: { a: CompareAgent; data: UseCaseCompareResponse; rule: RouteRule; runs: EvalRun[] | null; useCase: string }) {
  const frozen = evidenceIdsOf(a, data.agents, data.current_agent, rule)
  if (frozen) return <FrozenEvidence ids={frozen.ids} total={frozen.total} runs={runs} />
  if (!runs) return <p className="tma-body-sm tma-muted">The evidence runs could not be loaded.</p>
  const ids = new Set(a.variant_ids)
  const mine = runs.filter((r) => r.useCaseKey === useCase && ids.has(r.variant.id) && r.infraOk !== false)
  if (!mine.length) return <p className="tma-body-sm tma-muted">No evidence runs in your latest results list.</p>
  return (
    <ul className="stu-runs s12-evidence" data-testid="s12-evidence">
      {mine.map((r) =>
        r.evaluationId ? (
          <li key={r.id}>
            <Link to={evaluationHref(r.evaluationId)} className="tma-mono" data-testid="s12-evidence-link" data-run-id={r.id}>
              {r.caseKey} · {sha12(r.id)}
            </Link>
          </li>
        ) : (
          <li key={r.id} className="tma-mono tma-muted" data-testid="s12-evidence-unlinked" data-run-id={r.id}>
            {r.caseKey} · {sha12(r.id)} (uploaded, no evaluation page)
          </li>
        ),
      )}
    </ul>
  )
}

/** The evidence ids of the compare response; GET /eval-runs only adds the evaluation link and the case key. */
function FrozenEvidence({ ids, total, runs }: { ids: string[]; total: number; runs: EvalRun[] | null }) {
  if (!ids.length) return <p className="tma-body-sm tma-muted">No counted runs for this agent yet.</p>
  const byId = new Map((runs ?? []).map((r) => [r.id, r]))
  return (
    <>
      {total > ids.length && (
        <p className="tma-body-sm tma-muted" data-testid="s12-evidence-cut">
          showing {ids.length} of {total} runs
        </p>
      )}
      <ul className="stu-runs s12-evidence" data-testid="s12-evidence">
        {ids.map((id) => {
          const r = byId.get(id)
          return r?.evaluationId ? (
            <li key={id}>
              <Link to={evaluationHref(r.evaluationId)} className="tma-mono" data-testid="s12-evidence-link" data-run-id={id}>
                {r.caseKey} · {sha12(id)}
              </Link>
            </li>
          ) : (
            <li key={id} className="tma-mono tma-muted" data-testid="s12-evidence-unlinked" data-run-id={id}>
              {r ? `${r.caseKey} · ` : ''}
              {sha12(id)} {r ? '(uploaded, no evaluation page)' : '(not in your latest results list)'}
            </li>
          )
        })}
      </ul>
    </>
  )
}

function ApprovedRoute({ route }: { route: Route }) {
  return (
    <Card pad data-testid="s12-approved" data-route-id={route.id}>
      <span className="tma-label">Route approved</span>
      <dl className="stu-summary s12-dl">
        <dt>Route id</dt>
        <dd className="tma-mono s12-break" data-testid="s12-route-id">
          {route.id}
        </dd>
        <dt>State</dt>
        <dd>
          <span className="tma-badge tma-badge--neutral" data-testid="s12-route-state">
            {route.state}
          </span>
        </dd>
        <dt>Policy</dt>
        <dd className="tma-mono">{route.policy_version}</dd>
        {route.pr_url && (
          <>
            <dt>PR</dt>
            <dd>
              <a href={route.pr_url} target="_blank" rel="noreferrer" data-testid="s12-pr-link">
                {route.pr_url}
              </a>
            </dd>
          </>
        )}
      </dl>
      <p className="tma-body-sm tma-muted">The change itself goes by a pull request. Open it with the kit on your host:</p>
      <CopyCommand title="Open the route PR:" testId="s12-copy-command" command={routePrCommand(route.id)} />
    </Card>
  )
}

/** A pending swap: the applied route it would replace, its PR, and the person's decision. */
function SwapPending({ route, routes, onDecided }: { route: Route; routes: readonly Route[]; onDecided: () => Promise<void> }) {
  const applied = appliedRouteFor(route, routes)
  const [posting, setPosting] = useState<SwapDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = async (decision: SwapDecision) => {
    setPosting(decision)
    setError(null)
    try {
      await postSwapDecision(route.id, decision)
      await onDecided()
    } catch (e) {
      setError(postErrorText(e))
    } finally {
      setPosting(null)
    }
  }
  return (
    <div className="s12-swap" data-testid="s12-swap-pending" data-route-id={route.id}>
      <span className="tma-label">Swap pending</span>
      <p className="tma-body-sm">
        {applied ? (
          <span data-testid="s12-swap-applied" data-route-id={applied.id}>
            This route would replace <span className="tma-mono">{applied.id.slice(0, 8)}</span> · <span className="tma-mono">{applied.model_id}</span> · {applied.state} on{' '}
            <span className="tma-mono">{route.route_target}</span>.
          </span>
        ) : (
          <span data-testid="s12-swap-applied-missing">The route it would replace on {route.route_target} is not in this list.</span>
        )}{' '}
        Nothing changes until a person decides.
      </p>
      {route.pr_url && (
        <p className="tma-body-sm">
          <a href={route.pr_url} target="_blank" rel="noreferrer" data-testid="s12-swap-pr-link">
            {route.pr_url}
          </a>
        </p>
      )}
      <div className="s12-swap-actions">
        <button type="button" className="tma-btn tma-btn--primary" disabled={posting !== null} onClick={() => void decide('approve')} data-testid="s12-swap-approve">
          Approve swap
        </button>{' '}
        <button type="button" className="tma-btn" disabled={posting !== null} onClick={() => void decide('reject')} data-testid="s12-swap-reject">
          Reject swap
        </button>
      </div>
      {error && (
        <p className="tma-body-sm s12-error" role="alert" data-testid="s12-swap-error">
          {error}
        </p>
      )}
    </div>
  )
}

function RouteList({ routes, onReload }: { routes: Route[]; onReload: () => Promise<void> }) {
  if (!routes.length) return null
  return (
    <Card data-testid="s12-routes">
      <CardHeader title="Routes of this use case" meta={`${routes.length}`} />
      <ul className="stu-cases stu-pad">
        {routes.slice(0, 10).map((r) => (
          <li key={r.id} className="tma-body-sm s12-break" data-testid="s12-route-row" data-state={r.state}>
            <span className="tma-mono">{r.id.slice(0, 8)}</span> · {r.state} · <span className="tma-mono">{r.model_id}</span> · {r.verdict} ({r.picked_rule}), n {r.n}
            {r.pr_url && (
              <>
                {' '}
                ·{' '}
                <a href={r.pr_url} target="_blank" rel="noreferrer" data-testid="s12-pr-link">
                  PR
                </a>
              </>
            )}
            {isSwapPending(r) && <SwapPending route={r} routes={routes} onDecided={onReload} />}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function ApprovePanel({
  data,
  useCase,
  agent,
  live,
  rule,
  setRule,
  onApproved,
}: {
  data: UseCaseCompareResponse
  useCase: string
  agent: CompareAgent | null
  live: Route | null
  rule: RouteRule
  setRule: (r: RouteRule) => void
  onApproved: (r: Route) => void
}) {
  const ids = { kind: useId(), name: useId(), value: useId(), rollback: useId(), fallback: useId() }
  const liveTarget = live ? splitTarget(live.route_target) : null
  const [target, setTarget] = useState<TargetInput>({
    kind: liveTarget?.kind ?? 'env',
    name: liveTarget?.name ?? '',
    value: '',
    rollback: live?.target_value ?? '',
  })
  const [fallback, setFallback] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const verdictText = agent ? (rule === 'absolute' ? absoluteText(agent.absolute) : relativeText(agent.relative)) : ''
  const blockers = [...approveBlockers(agent, rule, verdictText), ...targetProblems(target)]
  const set = (k: keyof TargetInput) => (e: { target: { value: string } }) => setTarget((t) => ({ ...t, [k]: e.target.value }))

  const submit = async () => {
    if (!agent || blockers.length) return
    setPosting(true)
    setError(null)
    try {
      const body = approveBody({ useCase, agent: agent.agent_key, currentAgent: data.current_agent, rule, target, fallbackAgent: fallback && fallback !== agent.agent_key ? fallback : null })
      onApproved(await postApproveRoute(body))
    } catch (e) {
      setError(postErrorText(e))
    } finally {
      setPosting(false)
    }
  }

  return (
    <Card data-testid="s12-approve-panel">
      <CardHeader title="Pick rule and approve" />
      <form
        className="stu-pad s12-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <fieldset className="s12-fieldset">
          <legend className="tma-label">Rule</legend>
          {(['absolute', 'relative'] as const).map((r) => (
            <label key={r} className="s12-radio">
              <input type="radio" name="s12-rule" value={r} checked={rule === r} onChange={() => setRule(r)} data-testid={`s12-rule-${r}`} /> {r}
            </label>
          ))}
        </fieldset>
        <div className="s12-fields">
          <label htmlFor={ids.kind}>Target kind</label>
          <select id={ids.kind} value={target.kind} onChange={(e) => setTarget((t) => ({ ...t, kind: e.target.value as TargetKind }))} data-testid="s12-target-kind">
            <option value="env">env flag</option>
            <option value="claude-md">CLAUDE.md row</option>
          </select>
          <label htmlFor={ids.name}>{target.kind === 'env' ? 'Flag name' : 'Row name'}</label>
          <input id={ids.name} value={target.name} onChange={set('name')} pattern={target.kind === 'env' ? '[A-Z][A-Z0-9_]{1,63}' : '[a-z0-9][a-z0-9_\\-]{0,63}'} autoComplete="off" spellCheck={false} data-testid="s12-target-name" />
          <label htmlFor={ids.value}>Target value</label>
          <input id={ids.value} value={target.value} onChange={set('value')} pattern="[a-z0-9][a-z0-9_.:\-]{0,63}" autoComplete="off" spellCheck={false} data-testid="s12-target-value" />
          <label htmlFor={ids.rollback}>Rollback value (empty = not known)</label>
          <input id={ids.rollback} value={target.rollback} onChange={set('rollback')} pattern="[a-z0-9][a-z0-9_.:\-]{0,63}" autoComplete="off" spellCheck={false} data-testid="s12-rollback-value" />
          <label htmlFor={ids.fallback}>Fallback agent (optional)</label>
          <select id={ids.fallback} value={fallback} onChange={(e) => setFallback(e.target.value)} data-testid="s12-fallback">
            <option value="">None</option>
            {sortAgents(data.agents)
              .filter((a) => a.agent_key !== agent?.agent_key)
              .map((a) => (
                <option key={a.agent_key} value={a.agent_key}>
                  {agentLabel(a, a.agent_key)}
                </option>
              ))}
          </select>
        </div>
        {blockers.length > 0 && (
          <ul className="s12-blockers tma-body-sm" data-testid="s12-approve-reasons">
            {blockers.map((b) => (
              <li key={b} data-testid="s12-approve-reason">
                {b}
              </li>
            ))}
          </ul>
        )}
        <button type="submit" className="tma-btn tma-btn--primary s12-approve" disabled={posting || blockers.length > 0} data-testid="s12-approve">
          {posting ? 'Approving…' : 'Approve route'}
        </button>
        {error && (
          <p className="tma-body-sm s12-error" role="alert" data-testid="s12-approve-error">
            {error}
          </p>
        )}
      </form>
    </Card>
  )
}

export function RoutingView({ data, useCase }: { data: RoutingData; useCase: string }) {
  const { compare } = data
  const rec = useMemo(() => recommendAgent(compare.agents), [compare])
  // The routes as loaded, replaced by a fresh GET /routes after a swap decision.
  const [loadedRoutes, setLoadedRoutes] = useState<Route[] | null>(data.routes)
  const reloadRoutes = async () => {
    try {
      setLoadedRoutes((await getRoutes(useCase)).routes)
    } catch {
      // Keep the list as it was; the decision itself already answered.
    }
  }
  const live = loadedRoutes ? latestLive(loadedRoutes) : null
  const [picked, setPicked] = useState<string>(rec?.agent.agent_key ?? sortAgents(compare.agents)[0]?.agent_key ?? '')
  const [approved, setApproved] = useState<Route | null>(null)
  // The rule picked in the approve panel; the evidence list follows it (relative adds the current agent's runs).
  const [rule, setRule] = useState<RouteRule>('absolute')
  const agent = compare.agents.find((a) => a.agent_key === picked) ?? null
  const selectId = useId()
  const routes = [...(approved ? [approved] : []), ...(loadedRoutes ?? []).filter((r) => r.id !== approved?.id)]
  const cost = agent ? formatCost(agent.cost_per_task, agent.cost_label) : null

  return (
    <div className="stu-groups s12">
      <CurrentRoute live={live} routesError={data.routesError ?? null} />
      <Card data-testid="s12-recommendation" data-agent-key={rec?.agent.agent_key}>
        <CardHeader title="Recommendation" meta={`n ≥ ${ROUTING_MIN_N}, cheapest passing agent`} />
        <div className="stu-pad">
          {rec ? (
            <p className="tma-body-sm">
              <span className="tma-mono s12-break">{agentLabel(rec.agent, rec.agent.agent_key)}</span>: passes under the {rec.rules.join(' and the ')} rule
              {rec.rules.length > 1 ? 's' : ''}, n {rec.agent.n}, {formatCost(rec.agent.cost_per_task, rec.agent.cost_label).amount} {formatCost(rec.agent.cost_per_task, rec.agent.cost_label).label} per task.
            </p>
          ) : (
            <p className="tma-body-sm tma-muted">No agent holds a passing verdict with n ≥ {ROUTING_MIN_N} yet.</p>
          )}
        </div>
      </Card>
      {compare.agents.length === 0 ? (
        <Card pad data-testid="s12-empty">
          <span className="tma-label">No samples</span>
          <p className="tma-body-sm tma-muted">No runs for this use case yet.</p>
          <MoreSamples useCase={useCase} n={0} />
        </Card>
      ) : (
        <>
          <Card data-testid="s12-agent" data-agent-key={agent?.agent_key}>
            <CardHeader title="Agent to route" />
            <div className="stu-pad s12-agent">
              <p className="tma-body-sm s8-current">
                <label htmlFor={selectId}>Agent </label>
                <select id={selectId} value={picked} onChange={(e) => setPicked(e.target.value)} data-testid="s12-agent-select">
                  {sortAgents(compare.agents).map((a) => (
                    <option key={a.agent_key} value={a.agent_key}>
                      {agentLabel(a, a.agent_key)}
                      {rec?.agent.agent_key === a.agent_key ? ' (recommended)' : ''}
                    </option>
                  ))}
                </select>
              </p>
              {agent && (
                <>
                  <Verdicts a={agent} data={compare} />
                  <dl className="stu-summary s12-dl">
                    <dt>n</dt>
                    <dd className="tma-mono" data-testid="s12-n">
                      {agent.n}
                    </dd>
                    <dt>Mean score</dt>
                    <dd className="tma-mono">{formatScore(agent.mean_score)}</dd>
                    <dt>Cost per task</dt>
                    <dd data-testid="s12-cost">
                      <span className="tma-mono">{cost!.amount}</span>
                      {cost!.label && (
                        <span className="tma-label s8-cost-label" data-cost-label={cost!.label}>
                          {' '}
                          {cost!.label}
                        </span>
                      )}
                    </dd>
                    <dt>Policy</dt>
                    <dd className="tma-mono" data-testid="s12-policy">
                      {approved?.policy_version ?? live?.policy_version ?? 'the API default (stored on approval)'}
                    </dd>
                  </dl>
                  <span className="tma-label">Evidence runs</span>
                  <Evidence a={agent} data={compare} rule={approved ? approved.picked_rule : rule} runs={data.runs} useCase={useCase} />
                  {agent.n < ROUTING_MIN_N && <MoreSamples useCase={useCase} n={agent.n} />}
                </>
              )}
            </div>
          </Card>
          {approved ? <ApprovedRoute route={approved} /> : <ApprovePanel data={compare} useCase={useCase} agent={agent} live={live} rule={rule} setRule={setRule} onApproved={setApproved} />}
        </>
      )}
      <RouteList routes={routes} onReload={reloadRoutes} />
    </div>
  )
}

function errorText(status: number): string {
  if (status === 400) return 'This is not a use case pair. A use case is one taxonomy pair type/subtype, for example fix/prod-bug.'
  if (status === 503) return 'The routing view is not available yet: the result store is not migrated on this server.'
  return loadErrorText(status)
}

export function StudioRoutingPage({ data }: { data?: RoutingData }) {
  const { useCase = '' } = useParams()
  const [params] = useSearchParams()
  const current = params.get('current')
  const loaded = useStudioLoad(data ? null : () => loadRouting(useCase, current), [data ? 'prop' : 'api', useCase, current])
  const shown = data ?? (loaded.state === 'ok' ? loaded.data : null)
  return (
    <main className="tma-page s12-page" data-testid="studio-routing">
      <div className="stu-head">
        <p className="tma-body-sm s12-break">
          <Link to="/studio">Studio</Link> / <Link to={studioHref('S8', { use_case: useCase })}>compare</Link> / routing / {useCase}
        </p>
        <h1 className="tma-h1">
          <span className="tma-mono s12-break">{useCase}</span>
        </h1>
        <p className="stu-sub">Pick the agent for this use case from the evidence. Approving writes the verdict only; the change goes by a pull request.</p>
      </div>
      {shown ? (
        <RoutingView data={shown} useCase={useCase} />
      ) : loaded.state === 'error' ? (
        <Card pad data-testid="s12-error" data-status={loaded.status}>
          <span className="tma-label">No routing view</span>
          <p className="tma-body-sm tma-muted" data-testid="s12-load-error">
            {errorText(loaded.status)}
          </p>
        </Card>
      ) : (
        <Card pad data-testid="s12-loading">
          <span className="tma-body-sm tma-muted">Loading the routing view…</span>
        </Card>
      )}
    </main>
  )
}
