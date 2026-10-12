import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useSession, useSolBalance } from '../../auth/session'
import { Avatar, Button, IconChevronDown, Lockup, middle } from '../ui'

export type NavSection = 'agents' | 'evaluations' | 'tasks'

const LINKS: Array<{ id: NavSection; label: string; to: string }> = [
  { id: 'agents', label: 'Agents', to: '/agents' },
  { id: 'tasks', label: 'Tasks', to: '/tasks' },
  { id: 'evaluations', label: 'My evaluations', to: '/evaluations' },
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
            <Link key={l.id} to={l.to} className="tma-nav__link" aria-current={current === l.id ? 'page' : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      <AccountMenu />
    </header>
  )
}

/** Account trigger (28 px initials + short wallet) and the 288 px dropdown: balance, wallet, Copy, Disconnect. */
export function AccountMenu({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const session = useSession()
  const balance = useSolBalance()
  const [open, setOpen] = useState(defaultOpen)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  if (session.status !== 'signed-in' || !session.wallet) {
    const busy = session.status === 'connecting' || session.status === 'signing'
    return (
      <Button variant="secondary" size={36} onClick={session.signIn} disabled={busy}>
        {session.status === 'signing' ? 'Sign in your wallet…' : busy ? 'Connecting…' : 'Connect wallet'}
      </Button>
    )
  }

  const wallet = session.wallet
  const me = session.me
  const initials = me?.initials ?? wallet.slice(0, 2).toUpperCase()
  const copy = () => {
    void navigator.clipboard?.writeText(wallet).catch(() => undefined)
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="tma-account" ref={ref}>
      <button type="button" className="tma-account__trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="account-trigger">
        <Avatar initials={initials} size={28} src={me?.avatarUrl} shape="circle" />
        <span className="tma-account__short" title={wallet}>
          {middle(wallet, 4, 4)}
        </span>
        <IconChevronDown style={{ color: 'var(--tma-text-muted)' }} />
      </button>
      {open && (
        <div className="tma-account__menu" role="menu" data-testid="account-menu">
          <div className="tma-account__head">
            <Avatar initials={initials} size={40} surface="surface" src={me?.avatarUrl} shape="circle" />
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span className="tma-account__name">{me?.displayName ?? middle(wallet, 4, 4)}</span>
              {(me?.username ?? me?.handle) && <span className="tma-account__handle">@{me?.username ?? me?.handle}</span>}
            </div>
          </div>
          <div className="tma-account__section" style={{ gap: 4 }}>
            <span className="tma-label">Balance</span>
            <span className="tma-account__balance">
              {balance == null ? '—' : balance.toFixed(4)} <span className="tma-account__balance-unit">SOL · devnet</span>
            </span>
          </div>
          <div className="tma-account__section">
            <span className="tma-label">Wallet</span>
            <div className="tma-row" style={{ justifyContent: 'space-between' }}>
              <span className="tma-account__wallet" title={wallet}>
                <span className="tma-account__live" />
                {middle(wallet, 7, 5)}
              </span>
              <button type="button" className="tma-account__copy" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <span className="tma-body-sm tma-muted">{session.walletName ?? 'Wallet'} · connected</span>
          </div>
          <div className="tma-account__footer">
            <Link to="/settings/profile" role="menuitem" className="tma-account__disconnect tma-account__item" onClick={() => setOpen(false)} data-testid="profile-settings-link">
              Edit profile
            </Link>
            <button
              type="button"
              role="menuitem"
              className="tma-account__disconnect"
              onClick={() => {
                setOpen(false)
                void session.signOut()
              }}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
