import { useEffect, useRef, useState, type RefObject } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useSession } from '../../auth/session'
import { LoginButton } from '../../pages/LoginButton'
import { Avatar, Lockup } from '../ui'

export type NavSection = 'agents' | 'evaluations' | 'tasks' | 'studio' | 'traces' | 'graders' | 'routing' | 'more'

type NavLink = { id: NavSection; label: string; to: string; testId: string }

const LINKS: NavLink[] = [
  { id: 'agents', label: 'Agents', to: '/agents', testId: 'nav-agents' },
  { id: 'tasks', label: 'Tasks', to: '/tasks', testId: 'nav-tasks' },
  { id: 'evaluations', label: 'Evaluations', to: '/evaluations', testId: 'nav-my-evaluations' },
]

/**
 * The Studio sections as top-level items, as in the canvas header (plan 20261118-melhorias-tma, MT-03): Use cases
 * (the studio home, `studio`), Traces, Graders, Routing, and More. The canvas puts one item under More: the review queue.
 */
const STUDIO_LINKS: NavLink[] = [
  { id: 'studio', label: 'Use cases', to: '/studio', testId: 'nav-studio' },
  { id: 'traces', label: 'Traces', to: '/studio/traces', testId: 'nav-studio-traces' },
  { id: 'graders', label: 'Graders', to: '/studio/graders', testId: 'nav-studio-graders' },
  { id: 'routing', label: 'Routing', to: '/studio/routing', testId: 'nav-studio-routing' },
]
const MORE_LINKS: Array<{ label: string; to: string; testId: string }> = [{ label: 'Review queue', to: '/studio/review', testId: 'nav-studio-review' }]

/**
 * Item of the nav that a pathname marks active (02, 03, 08 → agents; 04, 09 → evaluations). In the studio: traces,
 * graders (with judge calibration), routing, more (the review queue); every other studio page sits under Use cases.
 */
export function sectionFor(pathname: string): NavSection | null {
  if (pathname.startsWith('/agents')) return 'agents'
  if (pathname.startsWith('/evaluations')) return 'evaluations'
  if (pathname.startsWith('/tasks')) return 'tasks'
  if (pathname !== '/studio' && !pathname.startsWith('/studio/')) return null
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`)
  if (under('/studio/traces')) return 'traces'
  if (under('/studio/graders') || under('/studio/calibration')) return 'graders'
  if (under('/studio/routing')) return 'routing'
  if (under('/studio/review')) return 'more'
  return 'studio'
}

/** App Nav: lockup, the app links and the Studio sections at the left, and an avatar-only account menu trigger. */
export function AppNav({ active }: { active?: NavSection | null }) {
  const { pathname } = useLocation()
  const current = active === undefined ? sectionFor(pathname) : active
  const link = (l: NavLink) => (
    <Link key={l.id} to={l.to} className="tma-nav__link" aria-current={current === l.id ? 'page' : undefined} data-testid={l.testId}>
      {l.label}
    </Link>
  )
  return (
    <header className="tma-nav" data-testid="app-nav">
      <div className="tma-nav__left">
        <Lockup to="/agents" />
        <nav className="tma-nav__links" aria-label="Main">
          {LINKS.map(link)}
          <span className="tma-nav__sep" aria-hidden="true" />
          {STUDIO_LINKS.map(link)}
          <MoreMenu active={current === 'more'} />
        </nav>
      </div>
      <AccountMenu />
    </header>
  )
}

/** "More": a small dropdown with the studio pages that have no top-level item (the canvas: the review queue). */
export function MoreMenu({ active = false, defaultOpen = false }: { active?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useDismiss(open, ref, () => setOpen(false), triggerRef)
  return (
    <div className="tma-nav__more" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="tma-nav__link tma-nav__more-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={active ? 'page' : undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid="nav-studio-more"
      >
        More
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="tma-nav__menu" role="menu" data-testid="nav-more-menu">
          {MORE_LINKS.map((l) => (
            <Link key={l.to} to={l.to} role="menuitem" className="tma-nav__menuitem" data-testid={l.testId} onClick={() => setOpen(false)}>
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

/** Close a menu on a pointer down outside it and on Escape (focus goes back to its trigger). */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void, triggerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
}

/** Account trigger and dropdown: identity stays in the menu to keep the navbar compact. */
export function AccountMenu({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const session = useSession()
  const [open, setOpen] = useState(defaultOpen)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useDismiss(open, ref, () => setOpen(false), triggerRef)

  if (session.status !== 'signed-in' || !session.user) return <LoginButton />

  const email = session.user.email
  const me = session.me
  const initials = me?.initials ?? email.slice(0, 2).toUpperCase()

  return (
    <div className="tma-account" ref={ref}>
      <button ref={triggerRef} type="button" className="tma-account__trigger tma-account__trigger--avatar" aria-label="Open account menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="account-trigger">
        <Avatar initials={initials} size={28} src={me?.avatarUrl} shape="circle" />
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
