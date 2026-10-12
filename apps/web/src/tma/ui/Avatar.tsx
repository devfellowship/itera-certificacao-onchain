/** Avatar sizes of the design and their corner radii (rounded squares). */
const RADIUS: Record<number, number> = { 80: 16, 72: 14, 44: 10, 40: 9, 28: 6 }
const FONT: Record<number, number> = { 80: 24, 72: 22, 44: 14, 40: 13, 28: 11 }

/** First two letters of a name, uppercase ("Bruno Lima" → "BL", "settlewise" → "SE"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return (words[0] ?? '?').slice(0, 2).toUpperCase()
}

export function Avatar({ name, initials, size = 40, surface }: { name?: string; initials?: string; size?: 80 | 72 | 44 | 40 | 28; surface?: 'raised' | 'surface' }) {
  const text = initials ?? initialsOf(name ?? '')
  return (
    <span
      className="tma-avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: RADIUS[size],
        fontSize: FONT[size],
        background: surface === 'surface' ? 'var(--tma-surface)' : undefined,
      }}
    >
      {text}
    </span>
  )
}
