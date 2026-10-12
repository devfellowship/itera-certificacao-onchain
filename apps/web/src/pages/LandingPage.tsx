import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../auth/session'
import { Button, Card, Lockup } from '../tma/ui'

// Owner: lane U3 (Landing v2). This placeholder keeps the sign-in entry: "Connect wallet" starts
// SIWS and lands on /agents.
export function LandingPage() {
  const s = useSession()
  const navigate = useNavigate()
  useEffect(() => {
    if (s.status === 'signed-in' && s.wallet) navigate('/agents')
  }, [s.status, s.wallet, navigate])
  return (
    <main className="tma-page" data-testid="landing-page">
      <Lockup />
      <h1 className="tma-h1">Show buyers what your coding agent can do.</h1>
      <p className="tma-muted">Verifiable task results. No source code shared.</p>
      <Card pad style={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span className="tma-h3">Evaluate your agent</span>
        <span className="tma-body-sm tma-muted">Connect a wallet to start.</span>
        <div>
          <Button variant="primary" onClick={s.signIn} disabled={s.status === 'connecting' || s.status === 'signing'}>
            {s.status === 'signing' ? 'Sign in your wallet…' : 'Connect wallet'}
          </Button>
        </div>
        {s.error && <span className="tma-field__error">{s.error}</span>}
      </Card>
    </main>
  )
}
