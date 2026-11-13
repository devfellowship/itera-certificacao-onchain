/**
 * S6 Experiment result (plan 20261112-tma-c5-studio-area-web2, task C5-T4), route /studio/experiments?agent=&case=.
 * The canonical page of an experiment (ADR-2): the matrix cases x agent variants of the caller's uploaded runs.
 * Each cell: repeats (n), pass count, pass rate with a 90 % Wilson interval, mean score, infra failures counted apart,
 * and the verified / self-declared marker. Per case, the verdict of each variant against the case baseline (the one
 * rule of tma/compare/case-compare.ts, rule text in a tooltip). Each cell links to its evaluation (/evaluations/:eid,
 * canonical); each variant links to S7 against the baseline. READ ONLY (ADR-5): no Save, no Start, no Run control.
 * Data: GET /eval-runs (filtered by ?agent= and ?case=).
 */
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { EvalRun, EvalVariant } from '../lib/api/types'
import { fmtScore } from '../tma/detail'
import { Badge, Card, CardHeader, SelfDeclaredBadge, Tip } from '../tma/ui'
import { CopyCommand } from './CopyCommand'
import { diffCommand } from './eval-command'
import { buildMatrix, cellStats, passRateText, verdictOf, type CellStats, type Matrix, type MatrixCase, type Verdict } from './experiment-matrix'
import { studioHref } from './links'
import { changeText, evaluationHref } from './runs'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

type Data = { runs: EvalRun[]; truncated: boolean; limit: number }

export const VERIFIED_TOOLTIP = 'TestMyAgent ran these runs (hosted).'

export function StudioExperimentsPage() {
  const [params] = useSearchParams()
  const agentFilter = params.get('agent')
  const caseFilter = params.get('case')
  const loaded = useStudioLoad<Data>(() => api.evalRuns({ agent: agentFilter, case: caseFilter }), [agentFilter, caseFilter])
  return (
    <main className="tma-page" data-testid="studio-experiments-page">
      <p className="tma-body-sm">
        <Link to="/studio">Studio</Link> / experiments
      </p>
      <div className="stu-head">
        <h1 className="tma-h1">Experiment results</h1>
        <p className="stu-sub">
          Test cases x agent variants, from your uploaded runs. An infra failure is a platform fault: it is counted apart, never as a fail. Read only.
        </p>
      </div>
      {loaded.state === 'loading' && (
        <Card pad data-testid="studio-loading">
          <span className="tma-body-sm tma-muted">Loading uploaded runs…</span>
        </Card>
      )}
      {loaded.state === 'error' && (
        <Card pad data-testid="studio-empty">
          <span className="tma-label">No experiment results to show</span>
          <p className="tma-body-sm tma-muted" data-testid="studio-load-error">
            {loadErrorText(loaded.status)}
          </p>
        </Card>
      )}
      {loaded.state === 'ok' && <MatrixView data={loaded.data} agentFilter={agentFilter} caseFilter={caseFilter} />}
    </main>
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

function Cell({ c, variant, baseRuns }: { c: MatrixCase; variant: EvalVariant; baseRuns: EvalRun[] | null }) {
  const runs = c.cells.get(variant.id)
  if (!runs?.length)
    return (
      <td className="stu-cell stu-cell--empty" data-testid="s6-cell-empty">
        <span className="tma-muted">—</span>
      </td>
    )
  const s = cellStats(runs)
  const isBase = c.baselineId === variant.id
  const verdict = !isBase && baseRuns ? verdictOf(baseRuns, runs) : null
  const [first, ...more] = s.evaluationIds
  return (
    <td className="stu-cell" data-testid="s6-cell" data-case={c.caseId} data-variant={variant.id}>
      <div className="stu-cell__top">
        {first ? (
          <Link to={evaluationHref(first)} data-testid="s6-cell-link" className="stu-cell__rate">
            {passRateText(s)}
          </Link>
        ) : (
          <span className="stu-cell__rate">{passRateText(s)}</span>
        )}
        {isBase && <Badge tone="neutral">baseline</Badge>}
      </div>
      <dl className="stu-cell__nums">
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
        {verdict && <VerdictMark verdict={verdict} />}
        {more.map((e) => (
          <Link key={e} to={evaluationHref(e)} className="tma-mono stu-count" data-testid="s6-cell-more">
            {e.slice(0, 8)}
          </Link>
        ))}
      </div>
    </td>
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
      <Card pad data-testid="studio-empty">
        <span className="tma-label">No uploaded runs</span>
        <p className="tma-body-sm tma-muted" data-testid="s6-empty">
          No uploaded eval runs{agentFilter ? ' for this agent' : ''}
          {caseFilter ? ' on this case' : ''} yet. Build the commands on <Link to={studioHref('S5', { agent: agentFilter, case: caseFilter })}>the experiment builder</Link>, then upload.
        </p>
      </Card>
    )

  return (
    <>
      <Card data-testid="s6-card">
        <CardHeader title="Cases x variants" meta={`${m.cases.length} ${m.cases.length === 1 ? 'case' : 'cases'} · ${m.variants.length} variants${data.truncated ? ` · newest ${data.limit} runs` : ''}`} />
        <div className="stu-matrix-wrap">
          <table className="stu-table stu-matrix" data-testid="s6-matrix">
            <thead>
              <tr>
                <th>Case</th>
                {m.variants.map((v) => (
                  <th key={v.id} data-testid="s6-variant-head">
                    {v.label} <span className="tma-muted">· {changeText(v.changeKind)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.cases.map((c) => {
                const baseRuns = c.baselineId ? (c.cells.get(c.baselineId) ?? null) : null
                return (
                  <tr key={c.caseId} data-testid="s6-row">
                    <th scope="row">
                      <Link to={`/studio/cases/${encodeURIComponent(c.caseId)}`} className="tma-mono">
                        {c.caseKey}
                      </Link>
                      <div className="tma-muted stu-count">{c.useCaseKey}</div>
                      <div className="stu-tags">
                        {c.baselineId &&
                          m.variants
                            .filter((v) => v.id !== c.baselineId && c.cells.has(v.id))
                            .map((v) => (
                              <Link key={v.id} to={studioHref('S7', { case: c.caseId, base: c.baselineId, variant: v.id })} data-testid="s6-diff-link" className="stu-count">
                                {`diff ${v.label} vs baseline`}
                              </Link>
                            ))}
                        {!c.baselineId && <span className="tma-muted stu-count">no baseline on this case</span>}
                      </div>
                    </th>
                    {m.variants.map((v) => (
                      <Cell key={v.id} c={c} variant={v} baseRuns={baseRuns} />
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {chosen && (
        <Card pad data-testid="s6-compare-command">
          {pairs.length > 1 && (
            <label className="tma-body-sm stu-tags">
              Pair
              <select value={Math.min(pick, pairs.length - 1)} onChange={(e) => setPick(Number(e.target.value))} aria-label="Pair to compare" data-testid="s6-pair">
                {pairs.map((p, i) => (
                  <option key={`${p.c.caseId}|${p.v.id}`} value={i}>
                    {`${p.c.caseKey}: ${p.v.label} vs ${p.base.label}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <CopyCommand
            title="Compare on your host"
            testId="s6-copy-command"
            command={diffCommand(chosen.c.caseKey, chosen.base, chosen.v)}
          />
        </Card>
      )}
    </>
  )
}
