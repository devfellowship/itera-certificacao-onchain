import type { ReactNode } from 'react'
import { Button, Card } from '../tma/ui'
import { useSession } from './session'

/** Gate for user routes: shows a connect card until SIWS completes. */
export function RequireSession({ children }: { children: ReactNode }) {
  const s = useSession()
  if (s.status === 'signed-in') return <>{children}</>
  const busy = s.status === 'connecting' || s.status === 'signing'
  return (
    <main className="tma-page" data-testid="require-session">
      <Card pad style={{ maxWidth: 480, margin: '48px auto 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span className="tma-h3">Connect a wallet to continue</span>
        <span className="tma-body-sm tma-muted">Sign in with your Solana wallet. The signature proves the address; it moves no funds.</span>
        <div>
          <Button variant="primary" onClick={s.signIn} disabled={busy}>
            {s.status === 'signing' ? 'Sign in your wallet…' : s.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
          </Button>
        </div>
        {s.error && <span className="tma-field__error">{s.error}</span>}
      </Card>
    </main>
  )
}
