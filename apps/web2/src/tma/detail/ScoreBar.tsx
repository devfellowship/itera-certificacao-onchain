import { PASS_LINE, type Interval } from './score'

/**
 * Score bar: a thin dark track, a lighter band for the confidence interval, a white tick at the
 * score, a dotted vertical line at the pass line. The positions are percentages of `max`.
 * `role="img"` with an `aria-label` that says the numbers.
 */
export function ScoreBar({ score, ci, passLine = PASS_LINE, max = 100, testId }: { score: number | null; ci?: Interval | null; passLine?: number; max?: number; testId?: string }) {
  const pct = (n: number) => `${Math.min(100, Math.max(0, (n / max) * 100))}%`
  const parts: string[] = []
  parts.push(score == null ? 'no score' : `score ${fmt(score)}`)
  if (ci) parts.push(`90% CI ${fmt(ci.lo)}–${fmt(ci.hi)}`)
  parts.push(`pass line ${fmt(passLine)}`)
  return (
    <span className="dt-scorebar" role="img" aria-label={parts.join(', ')} data-testid={testId ?? 'score-bar'}>
      <span className="dt-scorebar__track" />
      {ci && <span className="dt-scorebar__band" data-testid="score-bar-band" style={{ left: pct(ci.lo), width: `${Math.max(0, ((ci.hi - ci.lo) / max) * 100)}%` }} />}
      {score != null && <span className="dt-scorebar__tick" data-testid="score-bar-tick" style={{ left: pct(score) }} />}
      <span className="dt-scorebar__pass" data-testid="score-bar-pass" style={{ left: pct(passLine) }} />
    </span>
  )
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
