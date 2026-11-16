/**
 * S7 Result diff (plan 20261112-tma-c5-studio-area-web2, task C5-T4; redesign UI-S4S6S7), route
 * /studio/diff?case=&base=<variant id>&variant=<variant id>, or ?baseRun=&run=, or ?evaluation=<eid> (the
 * "Compare with baseline" link of /evaluations/:eid). Base run vs variant run side by side per data type,
 * rendered by the run page's own renderers (ArtifactCard of pages/run-artifacts/renderers.tsx, imported, not
 * copied; ADR-2), an "Expected vs agent" column when the case has an expected output, and the aligned step lists
 * of tma/compare/step-alignment.ts. Links back to both runs' canonical pages. READ ONLY (ADR-5).
 * Data: GET /runs/:id, GET /runs/:id/artifacts (owner; 404 -> derived list only), GET /runs/:id/actions,
 * GET /eval-cases/:id (expected output), and GET /eval-runs?case= or GET /evaluations/:id to find the pair.
 *
 * Layout: the canvas artboard "S7 Result diff per data type": a trail bar, the title with an (i) tip, a header row (the case,
 * the base run, the variant run with its result), then sections with one row per thing compared: Result, Outputs per
 * data type (with the Expected column), Tool calls (the aligned steps). The artboard also has per-check rows and the
 * final reply: those are not in the data this page reads, so the page says so in one line, with no made-up row.
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
import { Crumb, CrumbSep, InfoTip, StudioBar, TitleRow } from './chrome'
import { CopyCommand } from './CopyCommand'
import { diffCommand } from './eval-command'
import { studioHref } from './links'
import { alignmentWord, diffQueryOf, KIND_LABEL, newestRunOf, pairFromVariants, rowsByKind, stepsOfActions, type DiffQuery, type Pair } from './result-diff'
import { evaluationHref, runHref } from './runs'
import { Dot, themeClass } from './theme'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'
import './diff-page.css'

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

const DIFF_TIP =
  'Pick one test case from the experiment and one run on each side. Every row compares the same thing for the base agent and the variant. Only the output types this case produces are shown; HTML, JSON and image rows appear when a case makes them.'

export function StudioDiffPage() {
  const [params] = useSearchParams()
  const q = diffQueryOf(params)
  const key = params.toString()
  const loaded = useStudioLoad<Data>(() => loadDiff(q), [key])
  return (
    <main className={themeClass('tma-page', 'stu-page', 'df-page')} data-testid="studio-diff-page">
      <StudioBar
        trail={
          <>
            <Link to="/studio">Studio</Link>
            <CrumbSep />
            <Link to={studioHref('S6', { case: q.caseId })}>experiments</Link>
            <CrumbSep />
            <Crumb current>compare runs</Crumb>
          </>
        }
      />
      {loaded.state === 'loading' && (
        <div className="stu-body">
          <div className="stu-state" data-testid="studio-loading">
            <span className="tma-body-sm tma-muted">Loading both runs…</span>
          </div>
        </div>
      )}
      {loaded.state === 'error' && (
        <div className="stu-body">
          <div className="stu-state" data-testid="studio-empty">
            <span className="tma-label">No diff to show</span>
            <p className="tma-body-sm tma-muted" data-testid="studio-load-error">
              {loaded.status === 0 ? loaded.message : loadErrorText(loaded.status)}
            </p>
          </div>
        </div>
      )}
      {loaded.state === 'ok' && <DiffView data={loaded.data} />}
    </main>
  )
}

function variantOf(s: Side) {
  return s.run.variant ?? s.row?.variant ?? null
}

const resultOf = (status: string): { tone: 'ok' | 'bad' | 'warn' | 'muted'; path: string } =>
  status === 'pass'
    ? { tone: 'ok', path: 'M20 6 9 17l-5-5' }
    : status === 'fail'
      ? { tone: 'bad', path: 'M18 6 6 18M6 6l12 12' }
      : status === 'infra_error' || status === 'timeout' || status === 'invalid'
        ? { tone: 'warn', path: 'M12 8v5M12 16h.01' }
        : { tone: 'muted', path: 'M5 12h14' }

/** A column head of the artboard: the agent, what ran, and the result of this run. */
function SideHead({ s, which }: { s: Side; which: 'base' | 'variant' }) {
  const v = variantOf(s)
  const href = runHref({ id: s.run.runId, evaluationId: s.evaluationId })
  const res = resultOf(s.run.status)
  return (
    <div className="df-side" role="columnheader" data-testid={`s7-${which}-head`}>
      <span className="df-side__row">
        <span className="df-side__mark" aria-hidden="true">
          {(v?.agent.harness || '?').slice(0, 2).toUpperCase()}
        </span>
        <span className="df-side__text">
          <span className="df-side__name">
            {v?.label ?? s.run.runId.slice(0, 8)}
            {v?.isBaseline && <span className="stu-label"> · baseline</span>}
          </span>
          <span className="stu-label df-side__ver">
            {which === 'base' ? 'base' : 'variant'}
            {v ? ` · ${v.agent.harness}${v.agent.harnessVersion ? `@${v.agent.harnessVersion}` : ''} · ${v.agent.modelId}` : ''}
          </span>
        </span>
        <span className={`df-side__res stu-${res.tone === 'muted' ? 'label' : res.tone}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={res.path} />
          </svg>
          <span data-testid={`s7-${which}-status`}>{s.run.status}</span>
        </span>
      </span>
      <span className="df-side__links">
        <span className="tma-body-sm">score {fmtScore(s.run.scoreTotal ?? s.row?.score ?? null)}</span>
        {href ? (
          <Link to={href} className="stu-link" data-testid={`s7-${which}-run-link`}>
            Open the run page
          </Link>
        ) : (
          <span className="stu-gap">No evaluation page for this run</span>
        )}
        {s.evaluationId && (
          <Link to={evaluationHref(s.evaluationId)} className="stu-link" data-testid={`s7-${which}-evaluation-link`}>
            Evaluation {s.evaluationId.slice(0, 8)}
          </Link>
        )}
      </span>
    </div>
  )
}

function Cards({ list, which }: { list: Artifact[]; which: string }) {
  if (!list.length) return <span className="df-none">none</span>
  return (
    <div className="stu-cards">
      {list.map((a) => (
        <ArtifactCard key={a.id} artifact={a} collapsible defaultOpen={list.length === 1} testId={`s7-${which}-artifact`} />
      ))}
    </div>
  )
}

/** The section title row of the artboard: mono label, then a count in words. */
function Sec({ title, count }: { title: string; count?: string }) {
  return (
    <div className="df-sec">
      <span className="df-sec__title">{title}</span>
      {count && <span className="df-sec__count">{count}</span>}
    </div>
  )
}

const STEP_TONE: Record<string, string> = { same: 'same', changed: 'chg', inserted: 'add', removed: 'del' }

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
  const stepCounts = steps
    ? `${steps.alignment.rows.filter((r) => alignmentWord(r) !== 'same').length} of ${steps.alignment.rows.length} steps differ`
    : undefined

  return (
    <div className="stu-body stu-body--tight">
      <TitleRow tip={<InfoTip label="About the run comparison" text={DIFF_TIP} />}>
        <h1 className="tma-h1">Compare runs</h1>
      </TitleRow>

      <div className="df-scroll">
        <div className="df-table">
          <div className="df-head" role="row" data-testid="s7-runs">
            <div className="df-case" role="columnheader">
              <span className="df-case__mark" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3 17 2 2 4-4" />
                  <path d="m3 7 2 2 4-4" />
                  <path d="M13 6h8" />
                  <path d="M13 12h8" />
                  <path d="M13 18h8" />
                </svg>
              </span>
              <span className="df-case__text">
                {data.caseId && caseKey ? (
                  <Link to={`/studio/cases/${encodeURIComponent(data.caseId)}`} className="df-case__key" data-testid="s7-case-link">
                    {caseKey}
                  </Link>
                ) : (
                  <span className="df-case__key">{caseKey ?? 'Two runs'}</span>
                )}
                <span className="stu-label">test case{kase ? ` · ${kase.useCaseKey}` : ''}</span>
              </span>
            </div>
            <SideHead s={base} which="base" />
            <SideHead s={variant} which="variant" />
          </div>

          <Sec title="Result" />
          <div className="df-grid" data-testid="s7-result">
            <span className="df-grid__k">Result of the run</span>
            {[base, variant].map((s, i) => {
              const res = resultOf(s.run.status)
              return (
                <span key={i} className="df-cell">
                  <span className={`stu-${res.tone === 'muted' ? 'label' : res.tone}`}>{s.run.status}</span>
                  <span className="stu-label"> · score {fmtScore(s.run.scoreTotal ?? s.row?.score ?? null)}</span>
                </span>
              )
            })}
          </div>
          <p className="stu-gap df-gap" data-testid="s7-gap">
            Per-check results and the final reply are not in the data this page reads, so they have no row. Open the run page for them.
          </p>

          <Sec title="Outputs per data type" count={`${rows.length} data ${rows.length === 1 ? 'type' : 'types'}`} />
          <div data-testid="s7-card">
            <table className="df-outputs" data-testid="s7-table">
              <thead>
                <tr>
                  <th scope="col">Data type</th>
                  <th scope="col">Base{bv ? ` · ${bv.label}` : ''}</th>
                  <th scope="col">Variant{vv ? ` · ${vv.label}` : ''}</th>
                  {expected != null && (
                    <th scope="col" data-testid="s7-expected-head">
                      Expected vs agent
                    </th>
                  )}
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
                      <td rowSpan={rows.length} className="df-expected" data-testid="s7-expected">
                        <span className="stu-label">Expected (from the test case)</span>
                        <MarkdownView text={expected} testId="s7-expected-text" />
                        <p className="stu-gap">Read it against the agent outputs on the left, row by row.</p>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {expected == null && (
              <p className="stu-gap df-gap" data-testid="s7-no-expected">
                This test case states no expected output.
              </p>
            )}
          </div>

          <Sec title="Tool calls" count={stepCounts} />
          <div data-testid="s7-steps">
            {!steps ? (
              <p className="stu-gap df-gap" data-testid="s7-no-steps">
                The tool calls of one of the runs could not be read.
              </p>
            ) : steps.alignment.rows.length === 0 ? (
              <p className="stu-gap df-gap" data-testid="s7-no-steps">
                Neither run recorded a tool call.
              </p>
            ) : (
              <>
                <table className="df-steps" data-testid="s7-step-table">
                  <thead>
                    <tr>
                      <th scope="col">Alignment</th>
                      <th scope="col">Base step</th>
                      <th scope="col">Variant step</th>
                    </tr>
                  </thead>
                  <tbody>
                    {steps.alignment.rows.map((r, i) => {
                      const word = alignmentWord(r)
                      const tone = STEP_TONE[word]
                      const cell = (step: typeof r.base, targets: Map<number, string | null>, side: 'b' | 'v') =>
                        step ? (
                          <td className={`df-step df-step--${tone}`}>
                            <span className={`stu-dot df-step__dot${word === 'changed' ? ' stu-dot--warn' : word === 'same' ? '' : word === 'inserted' && side === 'v' ? ' stu-dot--ok' : ' stu-dot--bad'}`} aria-hidden="true" />
                            {`#${step.seq} ${step.tool} ${targets.get(step.seq) ?? ''}`}
                          </td>
                        ) : (
                          <td className="df-step df-step--none">no step</td>
                        )
                      return (
                        <tr key={i} data-testid="s7-step" data-label={word}>
                          <th scope="row" className="df-step__word">
                            {word}
                          </th>
                          {cell(r.base, steps.bTarget, 'b')}
                          {cell(r.variant, steps.vTarget, 'v')}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <p className="stu-gap df-gap">
                  <Dot /> same · <Dot tone="warn" /> changed · <Dot tone="ok" /> only in the variant · <Dot tone="bad" /> only in the base
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      {caseKey && bv && vv && <CopyCommand title="Compare on your host" testId="s7-copy-command" command={diffCommand(caseKey, bv, vv)} />}
    </div>
  )
}
