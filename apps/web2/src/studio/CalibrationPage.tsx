/**
 * S11 Judge calibration (plan 20261112-tma-c6-judge-calibration, task T6; restyled by plan 20261112-tma-c5-studio-area-web2,
 * C5-RD-S10-S11). Read only, no write control. Layout from the canvas artboard "S10-S11 Grader library + judge calibration",
 * with the Type filter on AI judges: one row per judge (version, labels it was proven against, runs to review, can decide)
 * and a side panel for the selected judge (what it checks, the agreement bars against the 90 % bar, the label counts, the
 * measured version with its interval, 2x2 counts and split sizes, the trend over versions, the contamination note).
 * A judge with no version shows an empty state that says what makes the first record appear.
 * Data: GET /grader-versions, GET /grader-versions/:id, GET /review-queue.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { InfoTip, TitleRow } from './chrome'
import { JUDGE_BAR, loadCalibration, type JudgeCalibration } from './calibration'
import { MeasuredVersion, VersionTrend } from './CalibrationParts'
import { decideOf, provenText } from './grader-library'
import { DecideMark, GroupHeading, HeadRow, LibraryShell, StateBox, TrustBox, TypeFilter } from './GraderLibraryParts'
import { JUDGE_TITLES } from './review'
import { loadErrorText, useStudioLoad } from './useStudioLoad'

const ABOUT = `How well each AI judge agrees with labeled runs. A judge decides a score only when TPR and TNR are both at least ${Math.round(JUDGE_BAR * 100)}% on a clean test split. Read only.`
const COLS = ['judge', 'type', 'version', 'proven', 'to review', 'can decide']

const newestOf = (c: JudgeCalibration) => (c.versions.length ? c.versions[c.versions.length - 1]! : null)

function JudgeRow({ c, on, onPick }: { c: JudgeCalibration; on: boolean; onPick: () => void }) {
  const v = newestOf(c)
  return (
    <div role="row" className={`grd-row${on ? ' grd-row--on' : ''}`} data-testid="calibration-judge" data-judge={c.judge} data-selected={on ? 'true' : undefined} onClick={onPick} onFocus={onPick}>
      <span role="cell" className="grd-cell">
        <Link to={`/studio/calibration/${encodeURIComponent(c.judge)}`} className="grd-name" data-testid="calibration-judge-link">
          {c.judge}
        </Link>
      </span>
      <span role="cell" className="grd-cell">AI judge</span>
      <span role="cell" className="grd-cell grd-mono">
        {v ? (
          <>
            {c.judge}@{v.semver}
            {c.versions.length > 1 && <span className="grd-more">+{c.versions.length - 1}</span>}
          </>
        ) : (
          'no version yet'
        )}
      </span>
      <span role="cell" className="grd-cell">{provenText('judge', v)}</span>
      <span role="cell" className="grd-cell grd-cell--num">
        <span data-testid="cal-to-review">{c.queue ? c.queue.toReview : 'unavailable'}</span>
      </span>
      <span role="cell" className="grd-cell">
        <DecideMark d={decideOf('judge', v, !!v)} testId="cal-row-decide" />
      </span>
    </div>
  )
}

/** The side panel: the selected judge. */
export function JudgePanel({ c }: { c: JudgeCalibration }) {
  const v = newestOf(c)
  return (
    <div className="grd-panel" data-testid="calibration-panel" data-judge={c.judge}>
      <div className="grd-aside__head">
        <span className="grd-eyebrow">AI judge{v ? ` · v${v.semver}` : ''}</span>
        <h2 className="grd-aside__title">{c.judge}</h2>
      </div>
      <section className="stu-section" aria-label="What it checks">
        <h3 className="grd-caps">What it checks</h3>
        <p className="grd-prose">{JUDGE_TITLES[c.judge]}</p>
      </section>
      <TrustBox d={decideOf('judge', v, !!v)} judge={{ tpr: v?.tpr ?? null, tnr: v?.tnr ?? null }} />
      <section className="stu-section" aria-label="Labels">
        <h3 className="grd-caps">Labels</h3>
        <dl className="grd-kv" data-testid="calibration-counts">
          <dt>Runs to review</dt>
          <dd>{c.queue ? c.queue.toReview : 'unavailable'}</dd>
          <dt>With a workflow label</dt>
          <dd data-testid="cal-workflow-labels">{c.queue ? c.queue.workflowLabels : 'unavailable'}</dd>
          <dt>Label rows, all sources</dt>
          <dd data-testid="cal-label-rows">{c.labelRows ?? 0}</dd>
        </dl>
      </section>
      {v ? (
        <section className="stu-section" aria-label="Measured version">
          <h3 className="grd-caps">Measured version</h3>
          <MeasuredVersion v={v} />
        </section>
      ) : (
        <div data-testid="calibration-empty" className="stu-section">
          <h3 className="grd-caps">No calibration yet</h3>
          <p className="tma-body-sm tma-muted">
            No version of this judge has a calibration record. The first one appears here after <span className="tma-mono">tma eval judge calibrate</span> measures the
            judge on a clean test split and the result is uploaded.
          </p>
        </div>
      )}
      {c.versions.length > 1 && <VersionTrend versions={c.versions} />}
      <details className="grd-details">
        <summary>Contamination check</summary>
        <p className="tma-body-sm tma-muted" data-testid="calibration-contamination">
          The eval repo CI refuses a golden set that shares an item with a calibration set, and a few-shot example from the test split. The result store does not keep
          the check result.
        </p>
      </details>
      <div className="grd-aside__actions">
        <Link to={`/studio/calibration/${encodeURIComponent(c.judge)}`} className="stu-btn stu-btn--primary" data-testid="calibration-panel-open">
          Open details
        </Link>
        <Link to={`/studio/review?judge=${encodeURIComponent(c.judge)}`} className="stu-btn stu-btn--secondary" data-testid="calibration-review-link">
          Label more runs
        </Link>
      </div>
    </div>
  )
}

export function CalibrationPage({ judges }: { judges?: JudgeCalibration[] }) {
  const loaded = useStudioLoad(judges ? null : loadCalibration, [judges ? 'prop' : 'api'])
  const list = judges ?? (loaded.state === 'ok' ? loaded.data : null)
  const [sel, setSel] = useState<string | null>(null)
  const cur = list ? list.find((c) => c.judge === sel) ?? list[0] ?? null : null
  return (
    <LibraryShell testId="studio-calibration" asideLabel="Selected judge" aside={cur ? <JudgePanel c={cur} /> : null}>
      <p className="stu-label grd-crumb">
        <Link to="/studio" data-testid="calibration-back">
          Studio
        </Link>{' '}
        /{' '}
        <Link to="/studio/graders" data-testid="calibration-graders-link">
          graders
        </Link>{' '}
        / AI judges
      </p>
      <TitleRow
        tip={<InfoTip label="About judge calibration" text={ABOUT} />}
        actions={
          <TypeFilter
            items={[
              { label: 'all', to: '/studio/graders', on: false },
              { label: 'code', to: '/studio/graders?type=code', on: false },
              { label: 'AI judges', to: '/studio/calibration', on: true },
              { label: 'human labels', to: '/studio/graders?type=human', on: false },
            ]}
          />
        }
      >
        <h1 className="tma-h1">Judge calibration</h1>
      </TitleRow>
      {!judges && loaded.state === 'loading' && <StateBox title="Loading" text="Loading calibration…" testId="calibration-loading" />}
      {!judges && loaded.state === 'error' && <StateBox title="Calibration is not available" text={loadErrorText(loaded.status)} testId="calibration-unavailable" />}
      {list && (
        <div className="grd-tablewrap">
          <div role="table" aria-label="AI judges" className="grd-table">
            <HeadRow cols={COLS} />
            <div role="rowgroup">
              <GroupHeading group="judge" count={list.length} />
              {list.map((c) => (
                <JudgeRow key={c.judge} c={c} on={cur?.judge === c.judge} onPick={() => setSel(c.judge)} />
              ))}
            </div>
          </div>
        </div>
      )}
    </LibraryShell>
  )
}
