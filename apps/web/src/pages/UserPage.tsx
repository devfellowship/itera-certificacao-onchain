/**
 * Public user page /u/:username (U36; Tainan TG 21099: the username implies a public page).
 * Data: GET /public/users/:username — avatar, name, @username, bio, listed agents with issued
 * evidence, public tasks. Open route: reads logged out.
 */
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import type { PublicUser } from '../lib/api'
import { AgentAvatar, Avatar } from '../tma/ui'
import './profile-settings/user-page.css'

export function UserPage() {
  const { username = '' } = useParams()
  const [data, setData] = useState<PublicUser | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading')

  useEffect(() => {
    let live = true
    setState('loading')
    api
      .publicUser(username.toLowerCase())
      .then((d) => {
        if (!live) return
        setData(d)
        setState('ok')
      })
      .catch((e) => live && setState(e instanceof ApiError && e.status === 404 ? 'missing' : 'error'))
    return () => {
      live = false
    }
  }, [username])

  if (state === 'loading') return <main className="tma-page" data-testid="user-page-loading" />
  if (state !== 'ok' || !data) {
    return (
      <main className="tma-page" data-testid="user-page-missing">
        <h1 className="tma-h1">{state === 'missing' ? 'User not found' : 'Could not load this user'}</h1>
        <p className="tma-muted">{state === 'missing' ? `No profile has the username @${username}.` : 'Try again in a moment.'}</p>
      </main>
    )
  }
  const u = data.user
  const name = u.displayName ?? `@${u.username}`
  return (
    <main className="tma-page tup" data-testid="user-page">
      <section className="tup-head">
        <Avatar size={80} src={u.avatarUrl} initials={u.initials} shape="circle" alt={name} />
        <div className="tup-head__text">
          <h1 className="tma-h1">{name}</h1>
          <span className="tup-handle">@{u.username}</span>
          {u.bio && <p className="tup-bio">{u.bio}</p>}
        </div>
      </section>

      <section className="tup-section">
        <span className="tma-label">Agents · {data.agents.length}</span>
        {data.agents.length === 0 ? (
          <p className="tma-muted tma-body-sm">No public agents yet.</p>
        ) : (
          <div className="tup-list">
            {data.agents.map((a) => (
              <Link key={a.id} to={`/agents/${a.id}`} className="tup-row" data-testid="user-agent-row">
                <AgentAvatar size={44} id={a.id} name={a.name} src={a.avatarUrl} author={{ name, avatarUrl: u.avatarUrl }} />
                <span className="tup-row__text">
                  <span className="tup-row__name">{a.name}</span>
                  {a.description && <span className="tup-row__desc">{a.description}</span>}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="tup-section">
        <span className="tma-label">Tasks · {data.tasks.length}</span>
        {data.tasks.length === 0 ? (
          <p className="tma-muted tma-body-sm">No public tasks yet.</p>
        ) : (
          <div className="tup-list">
            {data.tasks.map((t) => (
              <Link key={t.id} to={`/tasks/${t.slug}`} className="tup-row" data-testid="user-task-row">
                <span className="tup-row__text">
                  <span className="tup-row__name">{t.name}</span>
                  {t.description && <span className="tup-row__desc">{t.description}</span>}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
