import { Link, Outlet, useLocation } from 'react-router-dom'
import { DFL_CALLBACK_PATH } from '../config'
import { SessionProvider, useSession } from '../auth/session'
import { LoginButton } from './LoginButton'

/** Pages that render their own login button (or none). The nav does not repeat it there. */
const OWN_LOGIN_PATHS = new Set(['/', '/login', DFL_CALLBACK_PATH])

export function Nav() {
  const { user, logout } = useSession()
  const { pathname } = useLocation()
  return (
    <nav className="w2-nav" aria-label="Main">
      <Link to="/" className="w2-nav-brand tma-mono">
        TestMyAgent
      </Link>
      {user ? (
        <span className="w2-nav-user">
          <span data-testid="nav-user-email">{user.email}</span>
          <button type="button" className="w2-btn w2-btn-ghost" data-testid="nav-logout" onClick={logout}>
            Log out
          </button>
        </span>
      ) : OWN_LOGIN_PATHS.has(pathname) ? null : (
        <LoginButton />
      )}
    </nav>
  )
}

export function AppLayout() {
  return (
    <SessionProvider>
      <Nav />
      <Outlet />
    </SessionProvider>
  )
}
