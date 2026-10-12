import { Link } from 'react-router-dom'

/**
 * TMA mark: 8 polygons (design brief 1.7). viewBox 0 0 214 100 (wordmark) or 53 0 100 100 (symbol).
 * Tones (main, facet): green (default), cream, ink. `solid` makes the facets equal to main
 * (use below 32 px and for the favicon).
 */
const MAIN = ['0,0 58,0 58,24 0,24', '18,29 40,29 40,100 18,100', '63,0 85,0 85,100 63,100', '90,0 103,0 103,70', '121,0 143,0 143,100 121,100', '148,100 181,0 181,66 170,100']
const FACET = ['103,0 116,0 103,70', '181,0 214,100 192,100 181,66']

const TONES = {
  green: ['var(--tma-primary)', 'var(--tma-primary-hover)'],
  cream: ['var(--tma-text)', 'var(--tma-text-muted)'],
  ink: ['var(--tma-on-primary)', 'var(--tma-primary-soft)'],
} as const

export function Logo({ variant = 'wordmark', tone = 'green', solid, width, height, title = 'testmyagent' }: { variant?: 'wordmark' | 'symbol'; tone?: keyof typeof TONES; solid?: boolean; width?: number; height?: number; title?: string }) {
  const [main, facet] = TONES[tone]
  const viewBox = variant === 'wordmark' ? '0 0 214 100' : '53 0 100 100'
  return (
    <svg viewBox={viewBox} width={width} height={height} role="img" aria-label={title} style={{ display: 'block' }}>
      {MAIN.map((p) => (
        <polygon key={p} points={p} fill={main} />
      ))}
      {FACET.map((p) => (
        <polygon key={p} points={p} fill={solid ? main : facet} />
      ))}
    </svg>
  )
}

/** Primary horizontal lockup: wordmark 47x22 + 1px divider + "testmyagent.com" (17/600). */
export function Lockup({ to = '/' }: { to?: string }) {
  return (
    <Link className="tma-lockup" to={to} aria-label="testmyagent.com home">
      <Logo width={47} height={22} />
      <span className="tma-lockup__divider" />
      <span className="tma-lockup__name">
        testmyagent<span className="tma-lockup__tld">.com</span>
      </span>
    </Link>
  )
}
