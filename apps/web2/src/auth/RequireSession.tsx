import type { ReactNode } from 'react'
import { Button, Card } from '../tma/ui'
import { useSession } from './session'

/** Gate for user routes: shows a connect card until SIWS completes. */
export function RequireSession({ children }: { children: ReactNode }) {
  const s = useSession()
  if (s.status === 'signed-in') return <>{children}</>
  return (
    <main className="tma-page" data-testid="require-session">
      <Card pad style={{ maxWidth: 480, margin: '48px auto 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span className="tma-h3">Log in to continue</span>
        <span className="tma-body-sm tma-muted">Sign in with your DFL account.</span>
        <div>
          <Button variant="primary" onClick={s.signIn} data-testid="require-session-login">
            Login with DFL
          </Button>
        </div>
        {s.error && <span className="tma-field__error">{s.error}</span>}
      </Card>
    </main>
  )
}
