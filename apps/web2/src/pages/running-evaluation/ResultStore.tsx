/**
 * The result-store parts of the evaluation page (plan 20261112-tma-c4-result-store-trajectory-upload, T6; owner's
 * note Q-T13: extend the page that web2 already has, build no second app). Two small blocks:
 *   VariantStrip  under the score header: the variant label, a baseline badge, n and the grader `id@semver` of the evaluation.
 *   RunGraders    under the "Expected vs agent" table: the grading rows of the current run with `id@semver` next to each score,
 *                 and the trajectory summary.
 * Both render NOTHING when the API sent no such field (a v1 or hosted evaluation, or 0023 not applied yet).
 */
import type { ReviewDetail } from './review'
import { fmtGraderScore, graderLinesOf, graderSummariesOf, trajectoryTextOf, variantInfoOf } from './result-store'

export function VariantStrip({ detail }: { detail: Pick<ReviewDetail, 'case' | 'variant' | 'graders' | 'tasks'> }) {
  const variant = variantInfoOf(detail)
  const graders = graderSummariesOf(detail.graders)
  if (!variant && graders.length === 0) return null
  return (
    <div className="ev-store tma-card" data-testid="variant-strip" data-variant={variant ? variant.label : undefined} data-baseline={variant ? String(variant.isBaseline) : undefined}>
      {variant && (
        <div className="ev-store__row">
          <span className="tma-label">Variant</span>
          <strong data-testid="variant-label">{variant.label}</strong>
          {variant.isBaseline && (
            <span className="ev-badge ev-badge--baseline" data-testid="baseline-badge">
              baseline
            </span>
          )}
          {variant.changeKind && variant.changeKind !== 'none' && (
            <span className="ev-mono ev-dim" data-testid="variant-change">
              changes {variant.changeKind}
            </span>
          )}
          <span className="ev-mono ev-dim" data-testid="variant-n">
            n {variant.n}
          </span>
          {variant.caseKey && (
            <span className="ev-mono ev-dim" data-testid="variant-case">
              case {variant.caseKey}
              {variant.mode ? ` · ${variant.mode}` : ''}
            </span>
          )}
        </div>
      )}
      {graders.length > 0 && (
        <div className="ev-store__row">
          <span className="tma-label">Graders</span>
          {graders.map((g) => (
            <span key={g.key} className="ev-store__grader ev-mono" data-testid="grader-summary" data-grader={g.ref}>
              <code>{g.ref}</code>
              <span className="ev-dim">
                {' '}
                {g.pass}/{g.n} pass · {g.meanScore == null ? 'no score' : `mean ${g.meanScore.toFixed(1)}`}
                {g.hardGate ? ' · hard gate' : ''}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function RunGraders({ graders, trajectorySummary }: { graders?: unknown; trajectorySummary?: unknown }) {
  const lines = graderLinesOf(graders)
  const trajectory = trajectoryTextOf(trajectorySummary)
  if (lines.length === 0 && !trajectory) return null
  return (
    <div className="ev-store-run" data-testid="run-graders">
      {lines.length > 0 && (
        <ul className="ev-store-run__list">
          {lines.map((g) => (
            <li key={g.key} data-testid="run-grader" data-grader={g.ref} data-pass={String(g.pass)} data-latest={String(g.latest)} className={g.latest ? undefined : 'ev-dim'}>
              <code className="ev-mono">{g.ref}</code> <span className="ev-mono">{g.pass ? 'pass' : 'fail'} · {fmtGraderScore(g.score)}</span>
              {g.hardGate && <span className="ev-dim"> · hard gate</span>}
              {g.infraOk === false && <span className="ev-dim"> · infra error</span>}
              {!g.latest && <span className="ev-dim"> · replaced by a later grading</span>}
            </li>
          ))}
        </ul>
      )}
      {trajectory && (
        <span className="ev-mono ev-dim" data-testid="run-trajectory">
          trajectory · {trajectory}
        </span>
      )}
    </div>
  )
}
