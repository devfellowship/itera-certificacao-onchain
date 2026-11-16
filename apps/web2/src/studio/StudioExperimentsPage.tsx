/**
 * S6 Experiment result (plan 20261112-tma-c5-studio-area-web2, task C5-T4; redesign UI-S4S6S7), route /studio/experiments?agent=&case=.
 * The canonical page of an experiment (ADR-2): the matrix cases x agent variants of the caller's uploaded runs.
 * Each cell: repeats (n), pass count, pass rate with a 90 % Wilson interval, mean score, infra failures counted apart,
 * and the verified / self-declared marker. Per case, the verdict of each variant against the case baseline (the one
 * rule of tma/compare/case-compare.ts, rule text in a tooltip). Each cell links to its evaluation (/evaluations/:eid,
 * canonical); each variant links to S7 against the baseline. READ ONLY (ADR-5): no Save, no Start, no Run control.
 * Data: GET /eval-runs (filtered by ?agent= and ?case=).
 *
 * Layout: the canvas artboard "S6 Experiment result: base vs variant". One column per agent variant; rows in three groups:
 * Key metrics (pooled over the dataset), Agent (what differs between the columns) and Per test case (the repeats as
 * dots). Cost, tokens and wall time per run are on the artboard but not in the API: the page says so, with no value.
 */
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { EvalRun, EvalVariant } from '../lib/api/types'
import { fmtScore } from '../tma/detail'
import { Badge, SelfDeclaredBadge, Tip } from '../tma/ui'
import { Crumb, CrumbSep, StudioBar, TitleRow } from './chrome'
import { CopyCommand } from './CopyCommand'
import { diffCommand } from './eval-command'
import { buildMatrix, cellStats, isInfraFailure, passRateText, verdictOf, type CellStats, type Matrix, type MatrixCase, type Verdict } from './experiment-matrix'
import { bestIndex, rateOf, variantTotals, versusBase } from './experiment-summary'
import { studioHref } from './links'
import { changeText, evaluationHref, sha12 } from './runs'
import { Section, themeClass } from './theme'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'
import './matrix-page.css'

type Data = { runs: EvalRun[]; truncated: boolean; limit: number }

export const VERIFIED_TOOLTIP = 'TestMyAgent ran these runs (hosted).'

export function StudioExperimentsPage() {
  const [params] = useSearchParams()
  const agentFilter = params.get('agent')
  const caseFilter = params.get('case')
  const loaded = useStudioLoad<Data>(() => api.evalRuns({ agent: agentFilter, case: caseFilter }), [agentFilter, caseFilter])
  return (
    <main className={themeClass('tma-page', 'stu-page', 'mx-page')} data-testid="studio-experiments-page">
      <StudioBar
        trail={
          <>
            <Link to="/studio">Studio</Link>
            <CrumbSep />
            <Crumb current>experiments</Crumb>
          </>
        }
        actions={loaded.state === 'ok' ? <BarMeta data={loaded.data} /> : undefined}
      />
      {loaded.state === 'loading' && (
        <div className="stu-body">
          <div className="stu-state" data-testid="studio-loading">
            <span className="tma-body-sm tma-muted">Loading uploaded runs…</span>
          </div>
        </div>
      )}
      {loaded.state === 'error' && (
        <div className="stu-body">
          <div className="stu-state" data-testid="studio-empty">
            <span className="tma-label">No experiment results to show</span>
            <p className="tma-body-sm tma-muted" data-testid="studio-load-error">
              {loadErrorText(loaded.status)}
            </p>
          </div>
        </div>
      )}
      {loaded.state === 'ok' && <MatrixView data={loaded.data} agentFilter={agentFilter} caseFilter={caseFilter} />}
    </main>
  )
}

/** The mono summary in the bar: the dataset size and the repeats. */
function BarMeta({ data }: { data: Data }) {
  const m = useMemo(() => buildMatrix(data.runs), [data.runs])
  if (!m.cases.length) return null
  const repeats = Math.max(...m.cases.flatMap((c) => [...c.cells.values()].map((r) => r.length)))
  return (
    <span className="stu-label" data-testid="s6-bar-meta">
      {m.cases.length} test {m.cases.length === 1 ? 'case' : 'cases'} · up to {repeats} {repeats === 1 ? 'repeat' : 'repeats'}
    </span>
  )
}

function OriginMark({ origin }: { origin: CellStats['origin'] }) {
  if (origin === 'self-declared') return <SelfDeclaredBadge testId="s6-origin" />
  if (origin === 'verified')
    return (
      <Tip text={VERIFIED_TOOLTIP}>
        <span className="tma-badge tma-badge--success tma-badge--origin" data-origin="hosted" data-testid="s6-origin">
          Verified
        </span>
      </Tip>
    )
  if (origin === 'mixed')
    return (
      <span className="tma-badge tma-badge--neutral" data-origin="mixed" data-testid="s6-origin">
        Verified + self-declared
      </span>
    )
  return null
}

const VERDICT_TONE: Record<Verdict['label'], 'success' | 'danger' | 'neutral'> = { better: 'success', worse: 'danger', tie: 'neutral', refused: 'neutral' }

function VerdictMark({ verdict }: { verdict: Verdict }) {
  return (
    <Tip text={verdict.title}>
      <span data-testid="s6-verdict" data-verdict={verdict.label}>
        <Badge tone={VERDICT_TONE[verdict.label]}>{`vs baseline: ${verdict.text}`}</Badge>
      </span>
    </Tip>
  )
}

/** One dot per repeat, in order: green pass, red fail, dashed ring for an infra failure (not scored). */
function Dots({ runs }: { runs: EvalRun[] }) {
  const sorted = runs.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return (
    <span className="mx-dots" aria-hidden="true">
      {sorted.map((r) => (
        <span key={r.id} className={`mx-dot ${isInfraFailure(r) ? 'mx-dot--infra' : r.status === 'pass' ? 'mx-dot--pass' : 'mx-dot--fail'}`} />
      ))}
    </span>
  )
}

function Cell({ c, variant, baseRuns, best }: { c: MatrixCase; variant: EvalVariant; baseRuns: EvalRun[] | null; best: boolean }) {
  const runs = c.cells.get(variant.id)
  if (!runs?.length)
    return (
      <td className="stu-cell mx-cell mx-cell--empty" data-testid="s6-cell-empty">
        <span className="tma-muted">—</span>
      </td>
    )
  const s = cellStats(runs)
  const isBase = c.baselineId === variant.id
  const verdict = !isBase && baseRuns ? verdictOf(baseRuns, runs) : null
  const [first, ...more] = s.evaluationIds
  return (
    <td className={`stu-cell mx-cell${best ? ' mx-cell--best' : ''}`} data-testid="s6-cell" data-case={c.caseId} data-variant={variant.id}>
      <div className="mx-cell__top">
        <Dots runs={runs} />
        <span className="mx-cell__count">
          {s.pass} / {s.counted}
        </span>
        {isBase && <Badge tone="neutral">baseline</Badge>}
        {first ? (
          <Link to={evaluationHref(first)} data-testid="s6-cell-link" className="stu-link mx-cell__rate">
            {passRateText(s)}
          </Link>
        ) : (
          <span className="mx-cell__rate">{passRateText(s)}</span>
        )}
        {best && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="best" className="stu-ok mx-cell__best">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </div>
      <div className="mx-cell__line">
        {verdict && <VerdictMark verdict={verdict} />}
        {!isBase && c.baselineId && (
          <Link to={studioHref('S7', { case: c.caseId, base: c.baselineId, variant: variant.id })} data-testid="s6-diff-link" className="stu-label stu-link" title={`Compare the runs of ${variant.label} with the baseline`}>
            compare runs
          </Link>
        )}
        <details className="mx-more">
        <summary>details</summary>
        <dl className="mx-cell__nums">
          <dt>repeats</dt>
          <dd data-testid="s6-n">{s.n}</dd>
          <dt>pass</dt>
          <dd data-testid="s6-pass">
            {s.pass} of {s.counted}
          </dd>
          <dt>mean score</dt>
          <dd data-testid="s6-mean">{fmtScore(s.meanScore == null ? null : Math.round(s.meanScore * 10) / 10)}</dd>
          <dt>infra failures</dt>
          <dd data-testid="s6-infra" className={s.infra ? 'stu-warn' : undefined}>
            {s.infra}
          </dd>
        </dl>
        <div className="stu-tags">
          <OriginMark origin={s.origin} />
          {more.map((e) => (
            <Link key={e} to={evaluationHref(e)} className="stu-label stu-link" data-testid="s6-cell-more">
              {e.slice(0, 8)}
            </Link>
          ))}
        </div>
        </details>
      </div>
    </td>
  )
}

/** The cell of one metric row: the value, a small second line, and the check on the best column. */
function Metric({ value, sub, best, big }: { value: string; sub?: string; best?: boolean; big?: boolean }) {
  return (
    <td className={`mx-metric${best ? ' mx-metric--best' : ''}`}>
      <span className={`mx-metric__v${big ? ' mx-metric__v--big' : ''}`}>{value}</span>
      {sub && <span className="mx-metric__sub">{sub}</span>}
      {best && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="best" className="stu-ok mx-metric__best">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </td>
  )
}

/** A row of the Agent group. A "changed" pill marks a row whose value differs between the columns. */
function AgentRow({ label, values }: { label: string; values: string[] }) {
  const changed = new Set(values).size > 1
  return (
    <tr className="mx-row" data-testid="s6-agent-row">
      <th scope="row" className="mx-rowhead">
        {label}
        {changed && <span className="mx-changed">changed</span>}
      </th>
      {values.map((v, i) => (
        <td key={i} className="mx-metric">
          <span className="mx-metric__v mx-metric__v--mono">{v}</span>
        </td>
      ))}
      <Fill />
    </tr>
  )
}

/** The cell under the dashed "add" column: it keeps the hairline of the row going to the table edge. */
const Fill = () => <td className="mx-fill" aria-hidden="true" />

function GroupHead({ title, cols }: { title: string; cols: number }) {
  return (
    <tr className="mx-group">
      <th colSpan={cols + 2} scope="colgroup">
        {title}
      </th>
    </tr>
  )
}

function MatrixView({ data, agentFilter, caseFilter }: { data: Data; agentFilter: string | null; caseFilter: string | null }) {
  const m: Matrix = useMemo(() => buildMatrix(data.runs), [data.runs])
  const pairs = useMemo(
    () =>
      m.cases.flatMap((c) =>
        c.baselineId
          ? m.variants.filter((v) => v.id !== c.baselineId && c.cells.has(v.id)).map((v) => ({ c, base: m.variants.find((x) => x.id === c.baselineId)!, v }))
          : [],
      ),
    [m],
  )
  const [pick, setPick] = useState(0)
  const chosen = pairs[Math.min(pick, Math.max(0, pairs.length - 1))] ?? null

  if (!m.cases.length)
    return (
      <div className="stu-body">
        <div className="stu-state" data-testid="studio-empty">
          <span className="tma-label">No uploaded runs</span>
          <p className="tma-body-sm tma-muted" data-testid="s6-empty">
            No uploaded eval runs{agentFilter ? ' for this agent' : ''}
            {caseFilter ? ' on this case' : ''} yet. Build the commands on <Link to={studioHref('S5', { agent: agentFilter, case: caseFilter })}>the experiment builder</Link>, then upload.
          </p>
        </div>
      </div>
    )

  const cols = m.variants.length
  const totals = m.variants.map((v) => variantTotals(m, v.id))
  const versus = m.variants.map((v) => versusBase(m, v.id))
  const bestRate = bestIndex(totals.map((t) => t.passRate))
  const bestScore = bestIndex(totals.map((t) => t.meanScore))
  const lessInfra = bestIndex(totals.map((t) => -t.infra))
  const showVersus = versus.some((v) => v.compared > 0)
  const a = (v: EvalVariant) => v.agent
  const nonBaseline = m.variants.find((v) => !m.baselineOf.has(v.id)) ?? null

  return (
    <div className="stu-body stu-body--tight">
      <TitleRow
        actions={
          <>
            {chosen && (
              <Link to={studioHref('S7', { case: chosen.c.caseId, base: chosen.base.id, variant: chosen.v.id })} className="stu-btn stu-btn--secondary" data-testid="s6-bar-diff">
                Compare runs for {chosen.c.caseKey}
              </Link>
            )}
            <Link to={studioHref('S5', { agent: agentFilter, case: caseFilter })} className="stu-btn stu-btn--primary" data-testid="s6-add-variant">
              Add agent variant
            </Link>
          </>
        }
      >
        <h1 className="tma-h1">{cols > 2 ? 'Base agent vs agent variants' : 'Base agent vs agent variant'}</h1>
      </TitleRow>

      <div className="mx-scroll">
        <table className="stu-table stu-matrix mx-table" data-testid="s6-matrix" aria-label="Agent comparison" style={{ ['--mx-cols' as string]: cols }}>
          <thead>
            <tr>
              <th scope="col" className="mx-corner">
                <span className="mx-sr">Metric</span>
              </th>
              {m.variants.map((v) => (
                <th key={v.id} scope="col" className={`mx-agent${m.baselineOf.has(v.id) ? '' : ' mx-agent--variant'}`}>
                  <span className="mx-agent__row">
                    <span className="mx-agent__mark" aria-hidden="true">
                      {(v.agent.harness || '?').slice(0, 2).toUpperCase()}
                    </span>
                    <span className="mx-agent__text">
                      <span className="mx-agent__name" data-testid="s6-variant-head">
                        {v.label} <span className="tma-muted">· {changeText(v.changeKind)}</span>
                      </span>
                      <span className="mx-agent__role">{m.baselineOf.has(v.id) ? 'base agent' : 'agent variant'}</span>
                    </span>
                  </span>
                  <span className="mx-agent__ver stu-label">
                    {v.agent.harness}
                    {v.agent.harnessVersion ? `@${v.agent.harnessVersion}` : ''} · {v.agent.modelId} · {sha12(v.variantSha256)}
                  </span>
                </th>
              ))}
              <th scope="col" className="mx-addcol" data-testid="s6-add-column">
                <Link to={studioHref('S5', { agent: agentFilter, case: caseFilter })} className="mx-add">
                  <span className="mx-add__plus" aria-hidden="true">
                    +
                  </span>
                  <span className="mx-add__title">Add another agent variant</span>
                  <span className="stu-label">same {m.cases.length} test {m.cases.length === 1 ? 'case' : 'cases'}</span>
                </Link>
              </th>
            </tr>
          </thead>
          <tbody>
            <GroupHead title="Key metrics" cols={cols} />
            <tr className="mx-row">
              <th scope="row" className="mx-rowhead">
                Pass rate
              </th>
              {totals.map((t, i) => (
                <Metric key={i} big value={rateOf(t) == null ? 'no counted run' : `${rateOf(t)}%`} sub={t.interval ? `${t.pass} of ${t.counted} · 90% CI ${Math.round(t.interval.lo)}–${Math.round(t.interval.hi)}` : undefined} best={bestRate === i} />
              ))}
              <Fill />
            </tr>
            {showVersus && (
              <tr className="mx-row">
                <th scope="row" className="mx-rowhead">
                  vs base
                </th>
                {versus.map((v, i) =>
                  v.compared === 0 ? (
                    <Metric key={i} value={m.baselineOf.has(m.variants[i]!.id) ? 'baseline' : 'no baseline'} />
                  ) : (
                    <Metric
                      key={i}
                      value={v.pointsDelta == null ? 'no counted run' : `${v.pointsDelta > 0 ? '+' : ''}${v.pointsDelta} pts`}
                      sub={`better on ${v.better}, worse on ${v.worse}${v.undecided ? `, no clear difference on ${v.undecided}` : ''}`}
                    />
                  ),
                )}
                <Fill />
              </tr>
            )}
            <tr className="mx-row">
              <th scope="row" className="mx-rowhead">
                Mean score
              </th>
              {totals.map((t, i) => (
                <Metric key={i} value={t.meanScore == null ? '—' : fmtScore(Math.round(t.meanScore * 10) / 10)} best={bestScore === i} />
              ))}
              <Fill />
            </tr>
            <tr className="mx-row">
              <th scope="row" className="mx-rowhead">
                Repeats
              </th>
              {totals.map((t, i) => (
                <Metric key={i} value={String(t.n)} sub={`on ${t.cases} ${t.cases === 1 ? 'case' : 'cases'}`} />
              ))}
              <Fill />
            </tr>
            <tr className="mx-row">
              <th scope="row" className="mx-rowhead">
                Infra errors
              </th>
              {totals.map((t, i) => (
                <Metric key={i} value={String(t.infra)} sub={t.infra ? 'not scored' : undefined} best={lessInfra === i} />
              ))}
              <Fill />
            </tr>

            <GroupHead title="Agent" cols={cols} />
            <AgentRow label="Harness" values={m.variants.map((v) => `${a(v).harness}${a(v).harnessVersion ? `@${a(v).harnessVersion}` : ''}`)} />
            <AgentRow label="Model" values={m.variants.map((v) => a(v).modelId)} />
            <AgentRow label="Change" values={m.variants.map((v) => changeText(v.changeKind))} />
            <AgentRow label="Instructions" values={m.variants.map((v) => sha12(a(v).rulesSha256))} />
            <AgentRow label="Skills" values={m.variants.map((v) => sha12(a(v).skillsSha256))} />
            <AgentRow label="Tools / MCP" values={m.variants.map((v) => `${sha12(a(v).toolsSha256)} / ${sha12(a(v).mcpManifestSha256)}`)} />

            <GroupHead title="Per test case" cols={cols} />
            {m.cases.map((c) => {
              const baseRuns = c.baselineId ? (c.cells.get(c.baselineId) ?? null) : null
              const rates = m.variants.map((v) => {
                const r = c.cells.get(v.id)
                return r?.length ? (cellStats(r).passRate ?? null) : null
              })
              const best = bestIndex(rates)
              return (
                <tr key={c.caseId} className="mx-row mx-row--case" data-testid="s6-row">
                  <th scope="row" className="mx-rowhead mx-rowhead--case">
                    <Link to={`/studio/cases/${encodeURIComponent(c.caseId)}`} className="stu-link">
                      {c.caseKey}
                    </Link>
                    <span className="stu-label">{c.useCaseKey}</span>
                    {!c.baselineId && <span className="stu-label">no baseline on this case</span>}
                  </th>
                  {m.variants.map((v, i) => (
                    <Cell key={v.id} c={c} variant={v} baseRuns={baseRuns} best={best === i} />
                  ))}
                  <Fill />
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="stu-gap" data-testid="s6-gap">
        Cost, tokens and wall time per run are not in the uploaded results, so there is no row for them. Tools, MCP and permissions show as digests.
        {data.truncated ? ` Showing the newest ${data.limit} runs.` : ''}
      </p>
      <div className="mx-legend stu-label" aria-label="Legend">
        <span>
          <span className="mx-dot mx-dot--pass" /> pass
        </span>
        <span>
          <span className="mx-dot mx-dot--fail" /> fail
        </span>
        <span>
          <span className="mx-dot mx-dot--infra" /> infra error, not scored
        </span>
        {nonBaseline == null && <span>No agent variant yet: only the baseline has uploaded runs.</span>}
      </div>

      {chosen && (
        <Section title="Compare on your host" data-testid="s6-compare-command">
          {pairs.length > 1 && (
            <label className="mx-pair tma-body-sm">
              Pair
              <select value={Math.min(pick, pairs.length - 1)} onChange={(e) => setPick(Number(e.target.value))} aria-label="Pair to compare" data-testid="s6-pair" className="mx-select">
                {pairs.map((p, i) => (
                  <option key={`${p.c.caseId}|${p.v.id}`} value={i}>
                    {`${p.c.caseKey}: ${p.v.label} vs ${p.base.label}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <CopyCommand title="Compare on your host" testId="s6-copy-command" command={diffCommand(chosen.c.caseKey, chosen.base, chosen.v)} />
        </Section>
      )}
    </div>
  )
}
