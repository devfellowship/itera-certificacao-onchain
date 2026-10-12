/**
 * The one wallet prompt of screen 03 (plan 20261012-itera-testmyagent-ui-refactor, ADR-1; API PR #54).
 *
 *   1. POST /evaluations/quote/:reference/transaction → an unsigned legacy tx built by the API:
 *      [Memo itera-eval:v1 {evaluation_id, run_ids, …}, SOL transfer to the treasury + reference].
 *   2. The wallet signs it (one prompt). Its signature is every run's run_start_sig.
 *   3. The client sends it and waits for `confirmed`.
 *   4. POST /evaluations {reference, txSig}: the API validates the transfer (Solana Pay) and queues N runs.
 *      RPC lag can answer 402 payment_not_found for a few seconds, so this step retries for 60 s.
 *
 * TestMyAgent pays the model tokens (Gate Q2): there is no API key in this flow.
 */
import type { Connection } from '@solana/web3.js'
import { Transaction } from '@solana/web3.js'
import { api, ApiError } from '../../lib/api'
import type { CreateEvaluationResponse, Quote } from '../../lib/api'

export type PayErrorCode = 'rejected' | 'insufficient_funds' | 'quote_expired' | 'tx_failed' | 'not_confirmed' | 'wallet' | 'api'

export class PayError extends Error {
  constructor(
    public readonly code: PayErrorCode,
    message: string,
    public readonly txSig?: string,
  ) {
    super(message)
  }
}

export interface PayWallet {
  publicKey: { toBase58(): string } | null
  signTransaction?: (tx: Transaction) => Promise<Transaction>
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>
}

export type PayStep = 'building' | 'signing' | 'confirming' | 'registering'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function isRejection(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? ''
  const msg = e instanceof Error ? e.message : String(e)
  return /reject|denied|cancel|declined/i.test(msg) || /UserRejected/i.test(name)
}

function toBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function waitConfirmed(connection: Connection, sig: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const { value } = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })
    const st = value[0]
    if (st?.err) throw new PayError('tx_failed', 'The payment transaction failed on chain. Nothing was charged.', sig)
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return
    await sleep(1500)
  }
  throw new PayError('not_confirmed', 'The network did not confirm the payment in 60 s.', sig)
}

/** Runs the whole flow. `onStep` drives the button state. Resolves with the new evaluation. */
export async function payQuote(quote: Quote, wallet: PayWallet, connection: Connection, onStep: (s: PayStep) => void): Promise<CreateEvaluationResponse> {
  const account = wallet.publicKey?.toBase58()
  if (!account) throw new PayError('wallet', 'Connect your wallet to pay.')

  onStep('building')
  let built
  try {
    built = await api.quoteTransaction(quote.reference, account)
  } catch (e) {
    if (e instanceof ApiError) {
      const code = (e.body as { code?: string } | undefined)?.code
      if (code === 'insufficient_funds') throw new PayError('insufficient_funds', 'Insufficient balance for this payment and the network fee.')
      if (code === 'quote_expired') throw new PayError('quote_expired', 'The quote expired. A new quote is ready; press Pay again.')
      if (/recipient not found/i.test(e.message)) throw new PayError('api', 'Payments are paused: the TestMyAgent treasury account is not open on devnet. Nothing was charged.')
      if (/sender not found/i.test(e.message)) throw new PayError('insufficient_funds', 'This wallet has no SOL on devnet yet.')
    }
    throw new PayError('api', e instanceof Error ? e.message : String(e))
  }

  onStep('signing')
  const tx = Transaction.from(toBytes(built.transaction))
  let sig: string
  try {
    if (wallet.signTransaction) {
      const signed = await wallet.signTransaction(tx)
      onStep('confirming')
      sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
    } else {
      sig = await wallet.sendTransaction(tx, connection)
      onStep('confirming')
    }
  } catch (e) {
    if (isRejection(e)) throw new PayError('rejected', 'You rejected the request in your wallet. Nothing was charged.')
    const msg = e instanceof Error ? e.message : String(e)
    if (/insufficient|0x1\b|lamports/i.test(msg)) throw new PayError('insufficient_funds', 'Insufficient balance for this payment and the network fee.')
    throw new PayError('tx_failed', `The payment did not go through: ${msg}`)
  }
  await waitConfirmed(connection, sig)

  onStep('registering')
  const until = Date.now() + 60_000
  for (;;) {
    try {
      return await api.createEvaluation({ reference: quote.reference, txSig: sig })
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { code?: string } | undefined)?.code : undefined
      if (code === 'payment_not_found' && Date.now() < until) {
        await sleep(3000)
        continue
      }
      if (code === 'quote_expired') throw new PayError('quote_expired', 'The payment landed after the quote expired. Keep the transaction id and contact us.', sig)
      throw new PayError('api', e instanceof Error ? e.message : String(e), sig)
    }
  }
}
