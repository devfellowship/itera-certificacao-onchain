import { useState } from 'react'

/** Avatar sizes of the design and their corner radii (rounded squares). */
const RADIUS: Record<number, number> = { 80: 16, 72: 14, 44: 10, 40: 9, 28: 6, 20: 5 }
const FONT: Record<number, number> = { 80: 24, 72: 22, 44: 14, 40: 13, 28: 11, 20: 9 }

/** First two letters of a name, uppercase ("Bruno Lima" → "BL", "settlewise" → "SE"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return (words[0] ?? '?').slice(0, 2).toUpperCase()
}

export interface AvatarProps {
  name?: string
  initials?: string
  /** 20 is the author badge of a small agent tile (U36). */
  size?: 80 | 72 | 44 | 40 | 28 | 20
  /** U36: user avatars are circles (App Nav, account menu, author badge); agents stay rounded squares. */
  shape?: 'square' | 'circle'
  surface?: 'raised' | 'surface'
  /** Picture URL (user profile picture, lane U36). The initials show while it loads and when it fails. */
  src?: string | null
  /** Accessible name when `src` is set; the avatar is decorative (aria-hidden) when omitted. */
  alt?: string
}

/** Shared avatar: rounded square with initials, or a picture when `src` is given. User pictures (U36) and the model logos (U35) use it. */
export function Avatar({ name, initials, size = 40, surface, src, alt, shape = 'square' }: AvatarProps) {
  const text = initials ?? initialsOf(name ?? '')
  const [failed, setFailed] = useState(false)
  const showImg = !!src && !failed
  return (
    <span
      className="tma-avatar"
      aria-hidden={alt ? undefined : true}
      role={alt && showImg ? 'img' : undefined}
      aria-label={alt && showImg ? alt : undefined}
      style={{
        width: size,
        height: size,
        borderRadius: shape === 'circle' ? '50%' : RADIUS[size],
        fontSize: FONT[size],
        background: surface === 'surface' ? 'var(--tma-surface)' : undefined,
      }}
    >
      {showImg ? <img className="tma-avatar__img" src={src} alt="" width={size} height={size} onError={() => setFailed(true)} loading="lazy" decoding="async" /> : text}
    </span>
  )
}
