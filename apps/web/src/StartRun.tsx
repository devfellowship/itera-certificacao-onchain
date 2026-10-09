import { useWallet } from '@solana/wallet-adapter-react'
import { VersionedTransaction } from '@solana/web3.js'
import { useState } from 'react'

// Dev default points at the local run-issuer (services/run-issuer, port 8787). Override via
// VITE_RUN_ISSUER_URL for any other environment — never hardcode a prod URL here.
const RUN_ISSUER_URL = import.meta.env.VITE_RUN_ISSUER_URL ?? 'http://localhost:8787'

type Status =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'awaiting-signature' }
  | { kind: 'submitting' }
  | { kind: 'done'; signature: string }
  | { kind: 'error'; message: string }

/**
 * Build-order item 4's remaining half: wires the wallet to the run-issuer API.
 *
 * Two-step flow, matching services/run-issuer/src/server.ts:
 *   1. POST /api/runs/start -> a Memo transaction, already signed by Itera's hot key (the fee
 *      payer), with the connected wallet's signature slot still empty.
 *   2. The wallet adapter fills that slot (wallet.signTransaction never submits anything itself
 *      — it just adds a signature to what it's handed).
 *   3. POST /api/runs/submit with the now-fully-signed transaction; the server submits it.
 *
 * This is a throwaway, fixed payload for proving the flow end to end in the browser — a real
 * "start benchmark run" button would source scenario_id/agent_commit/etc. from the actual
 * selected scenario and agent, not these placeholders.
 */
export function StartRun() {
  const { publicKey, signTransaction, connected } = useWallet()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  async function start() {
    if (!publicKey || !signTransaction) return
    try {
      setStatus({ kind: 'building' })
      const startResponse = await fetch(`${RUN_ISSUER_URL}/api/runs/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userWallet: publicKey.toBase58(),
          run_id: crypto.randomUUID(),
          scenario_id: 'webhook-ledger',
          agent_repo: 'D0ingC0des/itera-agent-manifests',
          agent_commit: 'pending',
          model_id: 'pending',
          evaluator_commit: 'pending',
          fixture_hash: 'pending',
        }),
      })
      if (!startResponse.ok) throw new Error(`run-issuer /start failed: HTTP ${startResponse.status}`)
      const { wireTransactionBase64 } = (await startResponse.json()) as { wireTransactionBase64: string }

      setStatus({ kind: 'awaiting-signature' })
      const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(wireTransactionBase64), (c) => c.charCodeAt(0)))
      const signedTx = await signTransaction(tx)
      const signedBase64 = btoa(String.fromCharCode(...signedTx.serialize()))

      setStatus({ kind: 'submitting' })
      const submitResponse = await fetch(`${RUN_ISSUER_URL}/api/runs/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wireTransactionBase64: signedBase64 }),
      })
      if (!submitResponse.ok) throw new Error(`run-issuer /submit failed: HTTP ${submitResponse.status}`)
      const { signature } = (await submitResponse.json()) as { signature: string }
      setStatus({ kind: 'done', signature })
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  if (!connected) return null

  return (
    <div className="start-run">
      <button
        type="button"
        className="secondary"
        onClick={start}
        disabled={status.kind !== 'idle' && status.kind !== 'done' && status.kind !== 'error'}
      >
        {status.kind === 'idle' || status.kind === 'done' || status.kind === 'error'
          ? 'Start run (devnet test)'
          : status.kind === 'building'
            ? 'Building transaction…'
            : status.kind === 'awaiting-signature'
              ? 'Approve in your wallet…'
              : 'Submitting…'}
      </button>
      {status.kind === 'done' && (
        <p className="run-result">
          Signed with 0 extra SOL from your wallet —{' '}
          <a href={`https://explorer.solana.com/tx/${status.signature}?cluster=devnet`} target="_blank" rel="noreferrer">
            view on Explorer ↗
          </a>
        </p>
      )}
      {status.kind === 'error' && <p className="run-result run-result-error">{status.message}</p>}
    </div>
  )
}
