/**
 * S7 Result diff (plan 20261112-tma-c5-studio-area-web2, task C5-T4), route
 * /studio/diff?case=&base=<variant id>&variant=<variant id>, or ?baseRun=&run=, or ?evaluation=<eid> (the
 * "Compare with baseline" link of /evaluations/:eid). Base run vs variant run side by side per data type,
 * rendered by the run page's own renderers (ArtifactCard of pages/run-artifacts/renderers.tsx, imported, not
 * copied; ADR-2), an "Expected vs agent" column when the case has an expected output, and the aligned step lists
 * of tma/compare/step-alignment.ts. Links back to both runs' canonical pages. READ ONLY (ADR-5).
 * Data: GET /runs/:id, GET /runs/:id/artifacts (owner; 404 -> derived list only), GET /runs/:id/actions,
 * GET /eval-cases/:id (expected output), and GET /eval-runs?case= or GET /evaluations/:id to find the pair.
 */
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { EvalCaseDetail, EvalRun, Run, RunAction, RunArtifactsResponse } from '../lib/api/types'
import { artifactsOf, mergeStoredArtifacts, type Artifact } from '../pages/run-artifacts/artifacts'
import { ArtifactCard, MarkdownView } from '../pages/run-artifacts/renderers'
import '../pages/run-artifacts/run-artifacts.css'
import { alignSteps, ALIGNMENT_MAX_STEPS } from '../tma/compare/step-alignment'
import { fmtScore } from '../tma/detail'
import { Badge, Card, CardHeader } from '../tma/ui'
import { CopyCommand } from './CopyCommand'
import { diffCommand } from './eval-command'
import { studioHref } from './links'
import { alignmentWord, diffQueryOf, KIND_LABEL, newestRunOf, pairFromVariants, rowsByKind, stepsOfActions, type DiffQuery, type Pair } from './result-diff'
import { evaluationHref, runHref, statusTone } from './runs'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

/** Pages of 200 tool calls read per run, as on the run page. */
const MAX_ACTION_PAGES = 10

/** A reason S7 cannot show a pair (not an HTTP error). */
class DiffRefusal extends Error {}

type Side = { run: Run; artifacts: Artifact[]; actions: RunAction[] | null; evaluationId: string | null; row: EvalRun | null }
type Data = { base: Side; variant: Side; kase: EvalCaseDetail | null; caseId: string | null }

async function allActions(runId: string): Promise<RunAction[] | null> {
  const out: RunAction[] = []
  let after = 0
  try {
    for (let i = 0; i < MAX_ACTION_PAGES; i++) {
      const page = await api.runActions(runId, after)
      out.push(...page.actions)
      if (!page.hasMore) break
      after = page.nextAfterSeq
    }
  } catch {
    return out.length ? out : null
  }
  return out
}

async function side(runId: string, rows: EvalRun[]): Promise<Side> {
  const [run, stored, actions] = await Promise.all([
    api.run(runId),
    api.runArtifacts(runId).then(
      (r) => (r && Array.isArray(r.artifacts) ? r : null),
      () => null as RunArtifactsResponse | null,
    ),
    allActions(runId),
  ])
  const row = rows.find((r) => r.id === runId) ?? null
  return { run, artifacts: mergeStoredArtifacts(artifactsOf(run), stored), actions, evaluationId: run.evaluationId ?? row?.evaluationId ?? null, row }
}

async function loadDiff(q: DiffQuery): Promise<Data> {
  let pair: Pair
  let caseId = q.caseId
  let rows: EvalRun[] = []
  if (q.baseRun && q.run) {
    pair = { baseRunId: q.baseRun, variantRunId: q.run }
  } else if (q.evaluation) {
    const ev = await api.evaluation(q.evaluation)
    if (!ev.case || !ev.variant) throw new DiffRefusal('This evaluation has no test case and variant: only an uploaded eval result has a baseline to compare with.')
    if (ev.variant.isBaseline) throw new DiffRefusal('This evaluation is the baseline of its case: there is nothing to compare it with.')
    if (!ev.case.baselineVariantId) throw new DiffRefusal('The case of this evaluation has no baseline yet.')
    const variantRunId = ev.tasks[0]?.runId
    if (!variantRunId) throw new DiffRefusal('This evaluation has no run.')
    caseId = ev.case.id
    rows = (await api.evalRuns({ case: caseId })).runs
    const b = newestRunOf(rows, caseId, ev.case.baselineVariantId)
    if (!b) throw new DiffRefusal('The baseline of this case has no uploaded run.')
    pair = { baseRunId: b.id, variantRunId }
  } else if (q.caseId && q.base && q.variant) {
    rows = (await api.evalRuns({ case: q.caseId })).runs
    const r = pairFromVariants(rows, q.caseId, q.base, q.variant)
    if (!r.ok) throw new DiffRefusal(r.reason)
    pair = r.pair
  } else {
    throw new DiffRefusal('Pick a pair to compare: open it from Experiment results, or from "Compare with baseline" on an evaluation.')
  }
  const [base, variant] = await Promise.all([side(pair.baseRunId, rows), side(pair.variantRunId, rows)])
  caseId = caseId ?? base.run.case?.id ?? variant.run.case?.id ?? null
  const kase = caseId ? await api.evalCase(caseId).catch(() => null) : null
  return { base, variant, kase, caseId }
}

export function StudioDiffPage() {
  const [params] = useSearchParams()
  const q = diffQueryOf(params)
  const key = params.toString()
  const loaded = useStudioLoad<Data>(() => loadDiff(q), [key])
  return (
    <main className="tma-page" data-testid="studio-diff-page">
      <p className="tma-body-sm">
        <Link to="/studio">Studio</Link> / <Link to={studioHref('S6', { case: q.caseId })}>experiments</Link> / diff
      </p>
      <div className="stu-head">
        <h1 className="tma-h1">Result diff</h1>
        <p className="stu-sub">Base vs variant on one test case, per data type, with the expected output and the aligned steps. Read only.</p>
      </div>
      {loaded.state === 'loading' && (
        <Card pad data-testid="studio-loading">
          <span className="tma-body-sm tma-muted">Loading both runs…</span>
        </Card>
      )}
      {loaded.state === 'error' && (
        <Card pad data-testid="studio-empty">
          <span className="tma-label">No diff to show</span>
          <p className="tma-body-sm tma-muted" data-testid="studio-load-error">
            {loaded.status === 0 ? loaded.message : loadErrorText(loaded.status)}
          </p>
        </Card>
      )}
      {loaded.state === 'ok' && <DiffView data={loaded.data} />}
    </main>
  )
}

function variantOf(s: Side) {
  return s.run.variant ?? s.row?.variant ?? null
}

function SideHead({ s, which }: { s: Side; which: 'base' | 'variant' }) {
  const v = variantOf(s)
  const href = runHref({ id: s.run.runId, evaluationId: s.evaluationId })
  return (
    <div className="stu-side" data-testid={`s7-${which}-head`}>
      <span className="tma-label">{which === 'base' ? 'Base' : 'Variant'}</span>
      <span>
        {v?.label ?? s.run.runId.slice(0, 8)} {v?.isBaseline && <Badge tone="neutral">baseline</Badge>}
      </span>
      <span className="stu-tags">
        <Badge tone={statusTone(s.run.status)}>{s.run.status}</Badge>
        <span className="tma-body-sm">score {fmtScore(s.run.scoreTotal ?? s.row?.score ?? null)}</span>
      </span>
      <span className="stu-tags tma-body-sm">
        {href ? (
          <Link to={href} data-testid={`s7-${which}-run-link`}>
            Open the run page
          </Link>
        ) : (
          <span className="tma-muted">No evaluation page for this run</span>
        )}
        {s.evaluationId && (
          <Link to={evaluationHref(s.evaluationId)} data-testid={`s7-${which}-evaluation-link`}>
            Evaluation {s.evaluationId.slice(0, 8)}
          </Link>
        )}
      </span>
    </div>
  )
}

function Cards({ list, which }: { list: Artifact[]; which: string }) {
  if (!list.length) return <span className="tma-muted tma-body-sm">none</span>
  return (
    <div className="stu-cards">
      {list.map((a) => (
        <ArtifactCard key={a.id} artifact={a} collapsible defaultOpen={list.length === 1} testId={`s7-${which}-artifact`} />
      ))}
    </div>
  )
}

function DiffView({ data }: { data: Data }) {
  const { base, variant, kase } = data
  const rows = useMemo(() => rowsByKind(base.artifacts, variant.artifacts), [base.artifacts, variant.artifacts])
  const expected = kase?.taskSummary?.expected ?? null
  const steps = useMemo(() => {
    if (!base.actions || !variant.actions) return null
    const b = stepsOfActions(base.actions).slice(0, ALIGNMENT_MAX_STEPS)
    const v = stepsOfActions(variant.actions).slice(0, ALIGNMENT_MAX_STEPS)
    return { alignment: alignSteps(b, v), bTarget: new Map(base.actions.map((a) => [a.seq, a.target])), vTarget: new Map(variant.actions.map((a) => [a.seq, a.target])) }
  }, [base.actions, variant.actions])
  const bv = variantOf(base)
  const vv = variantOf(variant)
  const caseKey = kase?.caseKey ?? base.run.case?.caseKey ?? variant.run.case?.caseKey ?? null

  return (
    <>
      <Card data-testid="s7-runs">
        <CardHeader title={caseKey ? `Case ${caseKey}` : 'Two runs'} meta={kase ? kase.useCaseKey : undefined} />
        <div className="stu-pad stu-sides">
          <SideHead s={base} which="base" />
          <SideHead s={variant} which="variant" />
        </div>
      </Card>

      <Card data-testid="s7-card">
        <CardHeader title="Outputs per data type" meta={`${rows.length} data ${rows.length === 1 ? 'type' : 'types'}`} />
        <div className="stu-matrix-wrap">
          <table className="stu-table stu-diff" data-testid="s7-table">
            <thead>
              <tr>
                <th>Data type</th>
                <th>Base{bv ? ` · ${bv.label}` : ''}</th>
                <th>Variant{vv ? ` · ${vv.label}` : ''}</th>
                {expected != null && <th data-testid="s7-expected-head">Expected vs agent</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.kind} data-testid="s7-row" data-kind={r.kind}>
                  <th scope="row">{KIND_LABEL[r.kind]}</th>
                  <td>
                    <Cards list={r.base} which="base" />
                  </td>
                  <td>
                    <Cards list={r.variant} which="variant" />
                  </td>
                  {expected != null && i === 0 && (
                    <td rowSpan={rows.length} className="stu-expected" data-testid="s7-expected">
                      <span className="tma-label">Expected (from the test case)</span>
                      <MarkdownView text={expected} testId="s7-expected-text" />
                      <p className="tma-body-sm tma-muted">Read it against the agent outputs on the left, row by row.</p>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {expected == null && (
          <p className="stu-pad tma-body-sm tma-muted" data-testid="s7-no-expected">
            This test case states no expected output.
          </p>
        )}
      </Card>

      <Card data-testid="s7-steps">
        <CardHeader
          title="Aligned steps"
          meta={steps ? `${steps.alignment.counts.same} same · ${steps.alignment.counts.changed} changed · ${steps.alignment.rows.filter((r) => alignmentWord(r) === 'inserted').length} inserted · ${steps.alignment.rows.filter((r) => alignmentWord(r) === 'removed').length} removed` : undefined}
        />
        {!steps ? (
          <p className="stu-pad tma-body-sm tma-muted" data-testid="s7-no-steps">
            The tool calls of one of the runs could not be read.
          </p>
        ) : steps.alignment.rows.length === 0 ? (
          <p className="stu-pad tma-body-sm tma-muted" data-testid="s7-no-steps">
            Neither run recorded a tool call.
          </p>
        ) : (
          <table className="stu-table" data-testid="s7-step-table">
            <thead>
              <tr>
                <th>Base step</th>
                <th>Alignment</th>
                <th>Variant step</th>
              </tr>
            </thead>
            <tbody>
              {steps.alignment.rows.map((r, i) => {
                const word = alignmentWord(r)
                return (
                  <tr key={i} data-testid="s7-step" data-label={word}>
                    <td className="tma-mono">{r.base ? `#${r.base.seq} ${r.base.tool} ${steps.bTarget.get(r.base.seq) ?? ''}` : ''}</td>
                    <td>
                      <Badge tone={word === 'same' ? 'success' : word === 'changed' ? 'warning' : 'neutral'}>{word}</Badge>
                    </td>
                    <td className="tma-mono">{r.variant ? `#${r.variant.seq} ${r.variant.tool} ${steps.vTarget.get(r.variant.seq) ?? ''}` : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      {caseKey && bv && vv && (
        <Card pad>
          <CopyCommand title="Compare on your host" testId="s7-copy-command" command={diffCommand(caseKey, bv, vv)} />
        </Card>
      )}
    </>
  )
}

