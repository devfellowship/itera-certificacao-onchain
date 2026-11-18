/**
 * S11a AI judge (plan 20261112-tma-c6-judge-calibration, task T6; restyled by plan 20261112-tma-c5-studio-area-web2,
 * C5-RD-S10-S11). Read only. Layout from the canvas artboard "S11a AI judge details": the trail, the title with its
 * "AI judge · pass / fail", version and calibration marks, the question it answers, the tabs (Definition, Calibration,
 * Versions) and a side panel of labeled runs: the label of people or a workflow next to the judge verdict, a cross where
 * they disagree. Only a model name from the A11 Q1 = B list is printed.
 * The canvas write buttons (Save as, Label more runs as a write) are a copy command and a link to S13: the studio never
 * changes a judge. A judge changes by a pull request in dfl-evals.
 * The "try it" panel is the dry run of S10a (GraderDryRunPanel); it shows only when `tma studio serve` has a dry run route.
 * C5-SRC-SERVE (Q cd26fe07 = A): the Definition tab shows the judge prompt and its rubric, read only from Git at the stored
 * rubric digest (GET /grader-versions/:id/source). With no stored judge version there is no digest, so no prompt is shown.
 */
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { CopyCommand } from './CopyCommand'
import { calibrateCommand, isKnownJudge, JUDGE_BAR, loadJudge, pct, shownModel, type JudgeCalibration } from './calibration'
import { MeasuredVersion, RateBar, VersionTrend } from './CalibrationParts'
import { GraderDryRunPanel } from './GraderDryRunPanel'
import { decideOf } from './grader-library'
import { DecideMark, LibraryShell, StateBox } from './GraderLibraryParts'
import { JUDGE_TITLES, type ReviewRun } from './review'
import { shortDigest } from './graders'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import { JudgePrompt, SourceEmpty, SourceFacts, useGraderSource, type SourceState } from './GraderSourceParts'

type TabKey = 'definition' | 'calibration' | 'versions'

const pickVersion = (c: JudgeCalibration, version?: string | null) =>
  (version ? c.versions.find((x) => x.semver === version) : null) ?? (c.versions.length ? c.versions[c.versions.length - 1]! : null)

function Fact({ k, children, title, testId }: { k: string; children: React.ReactNode; title?: string; testId?: string }) {
  return (
    <div className="grd-fact">
      <dt>{k}</dt>
      <dd title={title} data-testid={testId}>
        {children}
      </dd>
    </div>
  )
}

export function JudgeDefinition({ c, version, source }: { c: JudgeCalibration; version?: string | null; source?: SourceState }) {
  const v = pickVersion(c, version)
  const loaded = useGraderSource(source || !v ? null : v.id)
  const src = source ?? loaded
  return (
    <section className="grd-head" data-testid="judge-definition" aria-label="Definition">
      {v ? (
        <>
          <dl className="grd-facts">
            <Fact k="Judge model" testId="judge-model">
              {shownModel(v.judgeModelId)}
            </Fact>
            <Fact k="Rubric digest" title={v.rubricSha256 ?? undefined} testId="judge-rubric">
              {v.rubricSha256 ? shortDigest(v.rubricSha256) : 'not recorded'}
            </Fact>
            <Fact k="Params digest" title={v.paramsSha256 ?? undefined} testId="judge-params">
              {v.paramsSha256 ? shortDigest(v.paramsSha256) : 'not recorded'}
            </Fact>
            <Fact k="Code digest" title={v.codeSha256}>
              {shortDigest(v.codeSha256)}
            </Fact>
            <Fact k="Created">{v.createdAt.slice(0, 10)}</Fact>
          </dl>
          {v.note && <p className="tma-body-sm tma-muted">Note: {v.note}</p>}
          {src.state === 'ready' ? <JudgePrompt s={src.data} /> : <SourceEmpty st={src} digest={v.rubricSha256 ?? v.codeSha256} what="judge prompt" />}
        </>
      ) : (
        <div data-testid="judge-empty" className="grd-state">
          <span className="tma-label">No version uploaded yet</span>
          <p className="tma-body-sm tma-muted">
            The judge definition lives in the eval repo (<span className="tma-mono">judges/{c.judge}/</span>). A version shows here after its first calibration result is uploaded.
            No judge version is stored, so there is no prompt digest, and the page shows no prompt text.
          </p>
        </div>
      )}
      <div className="grd-boxes">
        <section className="grd-box" aria-label="Answer choices">
          <h2 className="grd-caps">Answer choices</h2>
          <dl className="grd-box__rows">
            <dt>pass</dt>
            <dd>the run does what the question asks</dd>
            <dt>fail</dt>
            <dd>it does not, or the evidence is missing</dd>
          </dl>
        </section>
        <section className="grd-box" aria-label="Where the prompt lives">
          <h2 className="grd-caps">Where the prompt lives</h2>
          {v && src.state === 'ready' ? (
            <SourceFacts s={src.data} />
          ) : (
            <p className="tma-body-sm" data-testid="judge-prompt-where">
              The prompt and the rubric stay in Git, in <span className="grd-code">judges/{c.judge}/</span>. The result store keeps the rubric and params digests; the page
              reads the prompt only from a commit that gives those digests.
            </p>
          )}
        </section>
      </div>
    </section>
  )
}

function JudgeBar({ c, version }: { c: JudgeCalibration; version?: string | null }) {
  const v = pickVersion(c, version)
  return (
    <section className="grd-box" data-testid="judge-bar" aria-label="Bar">
      <h2 className="grd-caps">Bar · {Math.round(JUDGE_BAR * 100)}%</h2>
      <p className="tma-body-sm" data-testid="judge-bar-text">
        A judge is decisive only when TPR and TNR are both at least {Math.round(JUDGE_BAR * 100)}% on a clean test split.
      </p>
      {v ? (
        <MeasuredVersion v={v} />
      ) : (
        <>
          <RateBar label="TPR" value={null} k={null} n={null} testId="cal-tpr" />
          <RateBar label="TNR" value={null} k={null} n={null} testId="cal-tnr" />
        </>
      )}
    </section>
  )
}

const verdictWord = (p: boolean | null | undefined) => (p == null ? '—' : p ? 'pass' : 'fail')

function LabeledRow({ r }: { r: ReviewRun }) {
  const people = r.mine ?? r.workflow ?? null
  const judge = r.judge ?? null
  const both = people && judge
  const off = !!both && people.pass !== judge.pass
  const title = r.taskSummary?.before ?? r.caseKey
  return (
    <div role="row" className={`grd-labeled${off ? ' grd-labeled--off' : ''}`} data-testid="judge-labeled-run" data-agree={both ? String(!off) : undefined}>
      <span role="cell" className="grd-run__main" title={title}>
        {title}
        <span className="grd-run__sub grd-block">
          {r.runId.slice(0, 8)}
          {people && !r.mine ? ' · workflow' : ''}
        </span>
      </span>
      <span role="cell" className={people ? (people.pass ? 'grd-pass' : 'grd-fail') : 'grd-mono'}>
        {verdictWord(people?.pass)}
      </span>
      <span role="cell" className={judge ? (judge.pass ? 'grd-pass' : 'grd-fail') : 'grd-mono'}>
        {judge ? (judge.pass ? 'PASS' : 'FAIL') : '—'}
      </span>
      <span role="cell" aria-label={both ? (off ? 'disagree' : 'agree') : 'no comparison'}>
        {both ? (off ? '×' : '✓') : ''}
      </span>
    </div>
  )
}

/** The side panel: labeled runs (people or a workflow vs the judge), then the copy command and the dry run. */
function LabeledPanel({ c, version }: { c: JudgeCalibration; version?: string | null }) {
  const v = pickVersion(c, version)
  const shown = c.labeled.slice(0, 8)
  const compared = c.labeled.filter((r) => (r.mine ?? r.workflow) && r.judge)
  const agree = compared.filter((r) => (r.mine ?? r.workflow)!.pass === r.judge!.pass).length
  return (
    <div className="grd-panel" data-testid="judge-labeled">
      <div className="grd-aside__head">
        <h2 className="grd-aside__title">Labeled runs</h2>
        <p className="grd-aside__sub">Runs in the review queue with a label from people or a workflow, next to the judge verdict. Read only.</p>
      </div>
      {c.queue === null ? (
        <p className="tma-body-sm tma-muted">The review queue could not be read.</p>
      ) : shown.length === 0 ? (
        <p className="tma-body-sm tma-muted" data-testid="judge-labeled-empty">
          No run in the queue has a label yet.
        </p>
      ) : (
        <>
          <div role="table" aria-label="Labeled runs" className="grd-runs">
            <div role="row" className="grd-labeled grd-labeled--head">
              <span role="columnheader">run</span>
              <span role="columnheader">label</span>
              <span role="columnheader">judge</span>
              <span role="columnheader" aria-label="agrees" />
            </div>
            {shown.map((r) => (
              <LabeledRow key={r.runId} r={r} />
            ))}
          </div>
          <p className="tma-body-sm tma-muted" data-testid="judge-labeled-count">
            {shown.length} of {c.labeled.length} labeled runs shown.{' '}
            {compared.length > 0 ? `The judge agrees on ${agree} of ${compared.length} that have both.` : 'No run has both a label and a judge verdict yet.'}
          </p>
        </>
      )}
      <Link to={`/studio/review?judge=${encodeURIComponent(c.judge)}`} className="stu-btn stu-btn--secondary" data-testid="judge-review-link">
        Label more runs
      </Link>
      <div className="grd-aside__actions">
        <div className="grd-full">
          <span className="tma-label">Measure on your host</span>
          <CopyCommand command={calibrateCommand(c.judge, v?.semver ?? null, v?.judgeModelId ?? null)} title="Calibrate" testId="judge-command" />
        </div>
      </div>
      {v && <GraderDryRunPanel grader={`${v.graderId}@${v.semver}`} kind="judge" />}
    </div>
  )
}

function JudgeMain({ c, version }: { c: JudgeCalibration; version?: string | null }) {
  const [tab, setTab] = useState<TabKey>('definition')
  const v = pickVersion(c, version)
  const decide = decideOf('judge', v, !!v)
  const tabs: Array<{ key: TabKey; label: string; n?: string }> = [
    { key: 'definition', label: 'Definition' },
    { key: 'calibration', label: 'Calibration', n: v && v.tpr !== null ? pct(v.tpr) : undefined },
    { key: 'versions', label: 'Versions', n: String(c.versions.length) },
  ]
  return (
    <div className="grd-head">
      <div className="grd-title">
        <h1 className="tma-h1">{c.judge}</h1>
        <span className="grd-pill">AI judge · pass / fail</span>
        <span className="grd-pill">{v ? `v${v.semver}` : 'no version yet'}</span>
        <DecideMark d={{ ...decide, text: decide.tone === 'ok' ? 'Calibrated: can decide scores' : decide.title }} testId="judge-decide" />
      </div>
      <p className="grd-lead">{JUDGE_TITLES[c.judge]}</p>
      <div className="grd-tabs" role="tablist" aria-label="Judge">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="grd-tab" onClick={() => setTab(t.key)} data-testid={`judge-tab-${t.key}`}>
            {t.label}
            {t.n && <span className="grd-tab__n">{t.n}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="grd-head">
        {tab === 'definition' && (
          <>
            <JudgeDefinition c={c} version={version} />
            <JudgeBar c={c} version={version} />
          </>
        )}
        {tab === 'calibration' && (
          <>
            <JudgeBar c={c} version={version} />
            <details className="grd-details" open>
              <summary>Contamination check</summary>
              <p className="tma-body-sm tma-muted">
                The eval repo CI refuses a golden set that shares an item with a calibration set, and a few-shot example from the test split. The result store does not keep
                the check result.
              </p>
            </details>
          </>
        )}
        {tab === 'versions' &&
          (c.versions.length ? (
            <section data-testid="judge-trend">
              <VersionTrend versions={c.versions} />
            </section>
          ) : (
            <StateBox title="No version yet" text="A version shows here after its first calibration result is uploaded." />
          ))}
      </div>
    </div>
  )
}

export function CalibrationJudgePage({ judge: judgeProp, loaded: loadedProp }: { judge?: string; loaded?: JudgeCalibration }) {
  const params = useParams()
  const [search] = useSearchParams()
  const judge = judgeProp ?? params.judgeId ?? ''
  const known = isKnownJudge(judge)
  const loaded = useStudioLoad(loadedProp || !known ? null : () => loadJudge(judge), [judge, loadedProp ? 'prop' : 'api'])
  const data = loadedProp ?? (loaded.state === 'ok' ? loaded.data : null)
  const version = search.get('version')
  return (
    <LibraryShell testId="studio-calibration-judge" asideLabel="Labeled runs" wide aside={known && data ? <LabeledPanel c={data} version={version} /> : null}>
      <p className="stu-label grd-crumb">
        <Link to="/studio/graders">Graders</Link> /{' '}
        <Link to="/studio/calibration" data-testid="judge-back">
          AI judges
        </Link>{' '}
        / <span className="stu-text-2">{judge || 'judge'}</span>
      </p>
      {!known && <StateBox title="Unknown judge" text="This judge does not exist. Open a judge from the calibration list." testId="judge-unknown" />}
      {known && !loadedProp && loaded.state === 'loading' && <StateBox title="Loading" text="Loading judge…" testId="calibration-loading" />}
      {known && !loadedProp && loaded.state === 'error' && <StateBox title="The judge is not available" text={loadErrorText(loaded.status)} testId="calibration-unavailable" />}
      {known && data && <JudgeMain c={data} version={version} />}
    </LibraryShell>
  )
}
