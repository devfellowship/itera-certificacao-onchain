import type { ReactNode } from 'react'
import { useSession } from '../auth/session'
import { LoginButton } from './LoginButton'

/** Renders the children for a signed-in user. Else a short prompt with the "Login with DFL" button. */
export function RequireLogin({ children, what }: { children: ReactNode; what: string }) {
  const { user } = useSession()
  if (user) return <>{children}</>
  return (
    <main className="w2-shell">
      <h1>Sign in</h1>
      <p className="w2-lead">Sign in with your DFL account to {what}.</p>
      <LoginButton />
    </main>
  )
}
