import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useSession } from '../../auth/session'
import { LoginButton } from '../../pages/LoginButton'
import { Avatar, IconChevronDown, Lockup } from '../ui'

export type NavSection = 'agents' | 'evaluations' | 'tasks'

const LINKS: Array<{ id: NavSection; label: string; to: string; testId: string }> = [
  { id: 'agents', label: 'Agents', to: '/agents', testId: 'nav-agents' },
  { id: 'tasks', label: 'Tasks', to: '/tasks', testId: 'nav-tasks' },
  { id: 'evaluations', label: 'My evaluations', to: '/evaluations', testId: 'nav-my-evaluations' },
]

/** Section of the nav that a pathname marks active (02, 03, 08 → agents; 04, 09 → evaluations). */
export function sectionFor(pathname: string): NavSection | null {
  if (pathname.startsWith('/agents')) return 'agents'
  if (pathname.startsWith('/evaluations')) return 'evaluations'
  if (pathname.startsWith('/tasks')) return 'tasks'
  return null
}

/** App Nav (design brief 2.0): lockup + three links left (Agents, Tasks, My evaluations), account menu right. Height 56. */
export function AppNav({ active }: { active?: NavSection | null }) {
  const { pathname } = useLocation()
  const current = active === undefined ? sectionFor(pathname) : active
  return (
    <header className="tma-nav" data-testid="app-nav">
      <div className="tma-nav__left">
        <Lockup to="/agents" />
        <nav className="tma-nav__links" aria-label="Main">
          {LINKS.map((l) => (
            <Link key={l.id} to={l.to} className="tma-nav__link" aria-current={current === l.id ? 'page' : undefined} data-testid={l.testId}>
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      <AccountMenu />
    </header>
  )
}

/** Account trigger (28 px avatar + email) and the dropdown: name, email, Profile settings, Log out. */
export function AccountMenu({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const session = useSession()
  const [open, setOpen] = useState(defaultOpen)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  if (session.status !== 'signed-in' || !session.user) return <LoginButton />

  const email = session.user.email
  const me = session.me
  const initials = me?.initials ?? email.slice(0, 2).toUpperCase()

  return (
    <div className="tma-account" ref={ref}>
      <button type="button" className="tma-account__trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="account-trigger">
        <Avatar initials={initials} size={28} src={me?.avatarUrl} shape="circle" />
        <span className="tma-account__short" title={email} data-testid="nav-user-email">
          {email}
        </span>
        <IconChevronDown style={{ color: 'var(--tma-text-muted)' }} />
      </button>
      {open && (
        <div className="tma-account__menu" role="menu" data-testid="account-menu">
          <div className="tma-account__head">
            <Avatar initials={initials} size={40} surface="surface" src={me?.avatarUrl} shape="circle" />
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span className="tma-account__name">{me?.displayName ?? email}</span>
              <span className="tma-account__handle">{email}</span>
            </div>
          </div>
          <div className="tma-account__footer">
            <Link to="/settings/profile" role="menuitem" className="tma-account__disconnect tma-account__item" onClick={() => setOpen(false)} data-testid="profile-settings-link">
              Profile settings
            </Link>
            <button
              type="button"
              role="menuitem"
              className="tma-account__disconnect"
              data-testid="nav-logout"
              onClick={() => {
                setOpen(false)
                void session.signOut()
              }}
            >
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
