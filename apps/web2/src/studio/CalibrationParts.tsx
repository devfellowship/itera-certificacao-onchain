/**
 * Shared pieces of S11 and S11a (plan 20261112-tma-c6-judge-calibration, task T6): the rate bar with the 90 % mark,
 * the 2x2 counts, the split check and the version trend. Read only; no write control.
 */
import { Badge } from '../tma/ui'
import type { GraderVersionDetail } from './graders'
import { JUDGE_BAR, SPLIT_FLOOR, intervalText, passesBar, pct, splitCheck, wilson } from './calibration'
import './studio.css'

/** One rate (TPR or TNR) as a bar with a mark at the 90 % bar, the figure, and its interval from the counts. */
export function RateBar({ label, value, k, n, testId }: { label: 'TPR' | 'TNR'; value: number | null; k: number | null; n: number | null; testId: string }) {
  const ok = value !== null && value >= JUDGE_BAR
  const interval = k !== null && n !== null ? wilson(k, n) : null
  return (
    <div className="cal-rate" data-testid={testId}>
      <div className="cal-rate__head">
        <span className="tma-label">{label}</span>
        <span className="cal-rate__value" data-testid={`${testId}-value`}>
          {pct(value)}
        </span>
        <span className="tma-body-sm tma-muted" data-testid={`${testId}-bar-text`}>
          bar {Math.round(JUDGE_BAR * 100)}%
        </span>
      </div>
      <div className="cal-track" role="img" aria-label={`${label} ${pct(value)}, bar ${Math.round(JUDGE_BAR * 100)}%`}>
        <div className={`cal-fill${ok ? ' cal-fill--ok' : ''}`} style={{ width: `${Math.round((value ?? 0) * 1000) / 10}%` }} />
        <div className="cal-mark" style={{ left: `${JUDGE_BAR * 100}%` }} />
      </div>
      <span className="tma-body-sm tma-muted" data-testid={`${testId}-interval`}>
        {intervalText(interval)}
      </span>
    </div>
  )
}

/** The measured version: both rates, the verdict against the bar, the 2x2 counts and the split sizes. */
export function MeasuredVersion({ v }: { v: GraderVersionDetail }) {
  const c = v.calibration
  const split = c ? splitCheck(c) : null
  const decisive = passesBar(v) && (split?.clean ?? false)
  return (
    <div className="cal-measured" data-testid="cal-measured">
      <div className="cal-measured__top">
        <span className="tma-mono" data-testid="cal-version">
          {v.graderId}@{v.semver}
        </span>
        {v.tpr === null && v.tnr === null ? (
          <Badge tone="neutral" testId="cal-verdict">
            not measured
          </Badge>
        ) : decisive ? (
          <Badge tone="success" testId="cal-verdict">
            decisive: passes the bar
          </Badge>
        ) : (
          <Badge tone="warning" testId="cal-verdict">
            side signal only
          </Badge>
        )}
      </div>
      <RateBar label="TPR" value={v.tpr} k={c ? c.tp : null} n={c ? c.tp + c.fn : null} testId="cal-tpr" />
      <RateBar label="TNR" value={v.tnr} k={c ? c.tn : null} n={c ? c.tn + c.fp : null} testId="cal-tnr" />
      {c ? (
        <>
          <table className="stu-table cal-matrix" data-testid="cal-matrix">
            <thead>
              <tr>
                <th />
                <th>Judge says pass</th>
                <th>Judge says fail</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Label pass</th>
                <td data-testid="cal-tp">{c.tp}</td>
                <td data-testid="cal-fn">{c.fn}</td>
              </tr>
              <tr>
                <th scope="row">Label fail</th>
                <td data-testid="cal-fp">{c.fp}</td>
                <td data-testid="cal-tn">{c.tn}</td>
              </tr>
            </tbody>
          </table>
          <p className="tma-body-sm" data-testid="cal-split">
            Test split: {c.nTest} labels ({split!.pass} pass, {split!.fail} fail) of {c.nLabels} in all.{' '}
            {split!.clean ? `Both classes reach the floor of ${SPLIT_FLOOR}.` : `A decisive judge needs at least ${SPLIT_FLOOR} pass and ${SPLIT_FLOOR} fail labels in the test split.`}
          </p>
          {c.realignedAt && (
            <p className="tma-body-sm tma-muted" data-testid="cal-realigned">
              Last realigned {c.realignedAt}
            </p>
          )}
        </>
      ) : (
        <p className="tma-body-sm tma-muted" data-testid="cal-no-counts">
          This version has no label counts yet.
        </p>
      )}
      {v.testSplitSha256 && (
        <p className="tma-body-sm tma-muted">
          Test split digest <span className="tma-mono" title={v.testSplitSha256} data-testid="cal-split-digest">{v.testSplitSha256.slice(0, 12)}</span>
        </p>
      )}
    </div>
  )
}

/** The trend: one row per version, oldest first. */
export function VersionTrend({ versions }: { versions: GraderVersionDetail[] }) {
  if (versions.length === 0) return null
  return (
    <table className="stu-table" data-testid="cal-trend">
      <thead>
        <tr>
          <th>Version</th>
          <th>Created</th>
          <th>TPR</th>
          <th>TNR</th>
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => (
          <tr key={v.id} data-testid="cal-trend-row">
            <td className="tma-mono">{v.semver}</td>
            <td>{v.createdAt.slice(0, 10)}</td>
            <td>{pct(v.tpr)}</td>
            <td>{pct(v.tnr)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
