import { useState } from 'react'
import { refreshSolBalance } from '../../auth/session'
import { api, explorerTxUrl } from '../../lib/api'
import { Button } from '../ui'

type State = { phase: 'idle' } | { phase: 'busy' } | { phase: 'sent'; sol: number; txSig: string } | { phase: 'error'; message: string }

/** "Get test SOL" (U37): POST /faucet sends 0.02 devnet SOL to the signed-in wallet, once per 24 h. */
export function GetTestSol({ size = 30, variant = 'secondary' }: { size?: 30 | 32 | 36; variant?: 'secondary' | 'text' }) {
  const [state, setState] = useState<State>({ phase: 'idle' })

  async function claim() {
    setState({ phase: 'busy' })
    try {
      const r = await api.faucet()
      setState({ phase: 'sent', sol: r.sol, txSig: r.txSig })
      refreshSolBalance()
      // The RPC can lag a confirmed transfer by a moment: read the balance once more.
      window.setTimeout(refreshSolBalance, 2500)
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : 'Could not send test SOL. Try again later.'
      setState({ phase: 'error', message })
    }
  }

  if (state.phase === 'sent')
    return (
      <span className="tma-body-sm tma-muted" data-testid="faucet-sent">
        Sent {state.sol} SOL ·{' '}
        <a href={explorerTxUrl(state.txSig)} target="_blank" rel="noreferrer">
          view tx
        </a>
      </span>
    )

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <Button variant={variant} size={size} onClick={claim} disabled={state.phase === 'busy'} data-testid="get-test-sol">
        {state.phase === 'busy' ? 'Sending…' : 'Get test SOL'}
      </Button>
      {state.phase === 'error' && (
        <span className="tma-body-sm" role="alert" style={{ color: 'var(--tma-danger-text)' }} data-testid="faucet-error">
          {state.message}
        </span>
      )}
    </span>
  )
}
