import { useState } from 'react'
import { initialsOf } from './Avatar'

/**
 * U36 (Tainan TG 21086 / 21088): the agent tile with its author's badge.
 *
 * - Tile: the agent's uploaded picture, else a generated geometric tile in the TMA palette,
 *   deterministic from the agent id (same agent → same tile on every screen).
 * - Badge: the author's picture as a small circle with a dark ring on the bottom-right corner;
 *   the author's initials when they have no picture. Omitted when no author is given.
 *
 * Rule (TG 21095): next to an AgentAvatar with a badge, the "by {author}" text is the name only.
 */

export type AgentAvatarSize = 80 | 72 | 64 | 44 | 40 | 28
const RADIUS: Record<AgentAvatarSize, number> = { 80: 16, 72: 14, 64: 13, 44: 10, 40: 9, 28: 6 }
const BADGE: Record<AgentAvatarSize, number> = { 80: 26, 72: 24, 64: 22, 44: 18, 40: 16, 28: 12 }
const FONT: Record<AgentAvatarSize, number> = { 80: 24, 72: 22, 64: 20, 44: 14, 40: 13, 28: 11 }

export interface AgentAvatarAuthor {
  name?: string | null
  avatarUrl?: string | null
}

/** FNV-1a, 32 bit: a stable seed from the agent id (or name). */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const BG = ['var(--tma-primary)', 'var(--tma-surface-raised)', 'var(--tma-text-muted)', 'var(--tma-primary-soft)']
const FG = ['var(--tma-text)', 'var(--tma-bg)', 'var(--tma-primary)', 'var(--tma-surface)']

/** The generated tile: a background, one large tilted shape and one small accent (viewBox 0 0 44 44). */
export function AgentTileArt({ seed }: { seed: string }) {
  const h = hash(seed || '?')
  const bg = BG[h % BG.length]
  // The large shape never takes the background color.
  let fg = FG[(h >>> 3) % FG.length]
  if ((bg === 'var(--tma-primary)' && fg === 'var(--tma-primary)') || (bg === 'var(--tma-surface-raised)' && fg === 'var(--tma-surface)')) fg = 'var(--tma-text)'
  const accent = bg === 'var(--tma-primary)' ? 'var(--tma-bg)' : 'var(--tma-primary)'
  const kind = (h >>> 6) % 4
  const angle = ((h >>> 9) % 50) - 25
  const cx = 18 + ((h >>> 14) % 9)
  const cy = 18 + ((h >>> 18) % 9)
  const r = 9 + ((h >>> 22) % 5)
  const big =
    kind === 0 ? (
      <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={1.5} transform={`rotate(${angle} ${cx} ${cy})`} style={{ fill: fg }} />
    ) : kind === 1 ? (
      <circle cx={cx} cy={cy} r={r} style={{ fill: fg }} />
    ) : kind === 2 ? (
      <polygon points={`${cx},${cy - r - 2} ${cx + r + 2},${cy + r} ${cx - r - 2},${cy + r}`} transform={`rotate(${angle} ${cx} ${cy})`} style={{ fill: fg }} />
    ) : (
      <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={1.5} transform={`rotate(${angle} ${cx} ${cy})`} style={{ fill: 'none', stroke: fg, strokeWidth: 3 }} />
    )
  const ax = 6 + ((h >>> 25) % 8)
  const ay = 28 + ((h >>> 28) % 8)
  return (
    <svg viewBox="0 0 44 44" width="100%" height="100%" aria-hidden="true" focusable="false" className="tma-agent-avatar__art">
      <rect width="44" height="44" style={{ fill: bg }} />
      {big}
      <rect x={ax} y={ay} width="8" height="8" rx="1" transform={`rotate(${-angle} ${ax + 4} ${ay + 4})`} style={{ fill: accent }} />
    </svg>
  )
}

export function AgentAvatar({
  id,
  name,
  src,
  size = 44,
  author,
  testId,
}: {
  /** Agent id (or slug): the seed of the generated tile. */
  id?: string | null
  name: string
  /** The agent's uploaded picture. */
  src?: string | null
  size?: AgentAvatarSize
  /** The agent's author. Absent → no badge. */
  author?: AgentAvatarAuthor | null
  testId?: string
}) {
  const [tileFailed, setTileFailed] = useState(false)
  const [badgeFailed, setBadgeFailed] = useState(false)
  const showImg = !!src && !tileFailed
  const b = BADGE[size]
  const authorPic = author?.avatarUrl && !badgeFailed ? author.avatarUrl : null
  return (
    <span className="tma-agent-avatar" style={{ width: size, height: size }} data-testid={testId ?? 'agent-avatar'} aria-hidden="true">
      <span className="tma-agent-avatar__tile" style={{ borderRadius: RADIUS[size], fontSize: FONT[size] }}>
        {showImg ? <img src={src!} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setTileFailed(true)} /> : <AgentTileArt seed={id || name} />}
      </span>
      {author && (
        <span className="tma-agent-avatar__badge" style={{ width: b, height: b, fontSize: Math.round(b * 0.42) }} data-testid="author-badge">
          {authorPic ? <img src={authorPic} alt="" width={b} height={b} loading="lazy" decoding="async" onError={() => setBadgeFailed(true)} /> : initialsOf(author.name || '?').slice(0, 1)}
        </span>
      )}
    </span>
  )
}
