/**
 * Score rules shared by the detail pages (task, evaluation, run artifacts).
 *
 * PASS_LINE: ADR-5 (services/runner/src/outcome.ts, `allHiddenPassed`): a hosted run is PASS only
 * when EVERY hidden check passes (and every scored MCP final-state assertion holds). Score version 2
 * is the hidden ratio × 100, so the pass line of a score bar sits at 100, and "items ≥ threshold"
 * means "hidden checks passed k of n". Do not use the golden-set "pass ≥ 90" of the design: TMA does
 * not serve that grader.
 */
export const PASS_LINE = 100

/** z for a two-sided 90% interval. */
export const Z90 = 1.6449

export interface Interval {
  lo: number
  hi: number
}

/**
 * Wilson score interval of k successes in n trials, 90% confidence, on the 0–100 scale.
 * Returns null when n = 0 (nothing was measured).
 */
export function wilson90(k: number, n: number): Interval | null {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return null
  const p = Math.min(1, Math.max(0, k / n))
  const z2 = Z90 * Z90
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (Z90 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  const lo = Math.max(0, center - half) * 100
  const hi = Math.min(1, center + half) * 100
  return { lo: round1(lo), hi: round1(hi) }
}

/** Half of the width of an interval, 1 decimal. */
export function halfWidth(ci: Interval | null | undefined): number | null {
  if (!ci) return null
  return round1((ci.hi - ci.lo) / 2)
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** `85.2` or `85` for an integer; `—` for null. */
export function fmtScore(n: number | null | undefined): string {
  if (n == null) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
