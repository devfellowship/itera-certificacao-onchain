/** A small dot and the result word: green for pass, red for fail, grey for invalid, `—` when unknown. */
export type ResultWord = 'pass' | 'fail' | 'invalid'

export function resultWordOf(outcome: string | null | undefined): ResultWord | null {
  const w = (outcome ?? '').toLowerCase()
  if (w === 'pass' || w === 'fail' || w === 'invalid') return w
  if (w === 'timeout') return 'invalid'
  return null
}

export function ResultDot({ outcome, testId }: { outcome: string | null | undefined; testId?: string }) {
  const word = resultWordOf(outcome)
  return (
    <span className={`dt-result dt-result--${word ?? 'none'}`} data-testid={testId ?? 'result-dot'} data-result={word ?? ''}>
      <span className="dt-result__dot" aria-hidden="true" />
      {word ?? '—'}
    </span>
  )
}
