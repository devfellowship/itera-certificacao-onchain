import { useState } from 'react'
import { initialsOf } from '../../tma/ui'

/**
 * Small avatars of the Tasks page. User pictures and agent avatars belong to lane U36 (AgentAvatar,
 * UserAvatar); these draw the same shapes from the fields the API already sends (avatarUrl, name)
 * and are replaced by U36's components when they land.
 */
export function AuthorAvatar({ name, src, size = 20 }: { name: string; src?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="tkp-author-avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>
      {src && !failed ? <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} loading="lazy" /> : initialsOf(name)}
    </span>
  )
}

export function AgentTile({ name, initials, src, size = 28 }: { name: string; initials?: string; src?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="tkp-agent-tile" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>
      {src && !failed ? <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} loading="lazy" /> : (initials ?? initialsOf(name))}
    </span>
  )
}
