/**
 * Screen 03 — Select tasks + pay ("03 Select Tasks.dc.html"; plan 20261012-itera-testmyagent-ui-refactor, U11).
 *
 * Left: the shared Task Filter (inline, run mode). Only runnable tasks are selectable.
 * Right: the "Evaluation" summary. The price comes from POST /evaluations/quote (U7 v2): per run
 * the forecast model cost + the US$0.10 base fee, itemized; a flat US$0.20 when no forecast exists.
 * The quote lives 120 s and refreshes by itself. "Pay and start" is ONE wallet prompt: the payment
 * tx also carries the run-start Memo of every run. Then POST /evaluations and → /evaluations/:eid.
 * TestMyAgent pays the model tokens (Gate Q2): no API key field.
 */
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useSession, useSolBalance } from '../auth/session'
import { api, ApiError, explorerTxUrl } from '../lib/api'
import type { Agent, Model, Quote, Task } from '../lib/api'
import { TaskFilter, findTask, useTaskCatalog } from '../tma/task-filter'
import { Breadcrumb, Button, Stepper, middle } from '../tma/ui'
import { payQuote, PayError, type PayStep } from './select-tasks/pay'
import './select-tasks/select-tasks.css'

const STEPS = ['Agent', 'Tasks', 'Evaluation', 'Results']
/** Re-quote a little before the API's 120 s window ends, so a payment never races the expiry. */
const REQUOTE_MARGIN_MS = 8_000
const LAMPORTS = 1_000_000_000
/** Network fee + Memo headroom checked against the balance before the wallet prompt. */
const FEE_HEADROOM_SOL = 0.00002

type QuoteState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; quote: Quote; key: string }
  | { status: 'error'; message: string }

type PayState = { step: 'idle' } | { step: PayStep } | { step: 'done'; txSig: string; evaluationId: string }

const usd = (n: number) => `$${n.toFixed(2)}`
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function quoteErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 503) return /price/i.test(e.message) ? 'Price unavailable, try again.' : e.message
    if (e.status === 429) return e.message.replace(/^daily limit: /, 'Daily limit reached: ')
    if (e.status === 409) return e.message
    if (e.status === 404) return 'This agent or task is not available.'
    return e.message
  }
  return e instanceof Error ? e.message : 'Could not price this evaluation.'
}

function commitOf(agent: Agent | null): string | null {
  if (!agent) return null
  const latest = (agent as { latestVersion?: { commitSha?: string } | null }).latestVersion
  return agent.pinnedCommit ?? latest?.commitSha ?? null
}

function useCountdown(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [expiresAt])
  // Clamp to the 120 s window: a client clock a little behind the API must not show 2:03.
  return expiresAt ? Math.min(120_000, Math.max(0, Date.parse(expiresAt) - now)) : null
}

export function SelectTasksPage() {
  const { aid = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const session = useSession()
  const balance = useSolBalance()
  const wallet = useWallet()
  const walletModal = useWalletModal()
  const { connection } = useConnection()
  const catalogState = useTaskCatalog()
  const catalog = catalogState.status === 'ready' ? catalogState.catalog : null

  const [agent, setAgent] = useState<Agent | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [models, setModels] = useState<Model[]>([])
  const [quoteState, setQuoteState] = useState<QuoteState>({ status: 'idle' })
  const [pay, setPay] = useState<PayState>({ step: 'idle' })
  const [payError, setPayError] = useState<string | null>(null)
  const [quoteNonce, setQuoteNonce] = useState(0)
  const paying = pay.step !== 'idle' && pay.step !== 'done'

  // Agent + model label.
  useEffect(() => {
    let live = true
    api
      .agent(aid)
      .then((r) => live && setAgent(r.agent))
      .catch((e: unknown) => live && setAgentError(e instanceof ApiError && e.status === 404 ? 'Agent not found.' : e instanceof Error ? e.message : String(e)))
    api
      .models()
      .then((r) => live && setModels(r.models))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [aid])

  // Selection: ?tasks= ids or slugs. Default = the first runnable task (the design preselects one).
  const urlTasks = params.get('tasks')
  const selected = useMemo<Task[]>(() => {
    if (!catalog) return []
    if (urlTasks === null) {
      const first = catalog.tasks.find((t) => t.runnable && !t.mine) ?? catalog.tasks.find((t) => t.runnable)
      return first ? [first] : []
    }
    return urlTasks
      .split(',')
      .filter(Boolean)
      .map((s) => findTask(catalog.tasks, s))
      .filter((t): t is Task => Boolean(t && t.runnable))
  }, [catalog, urlTasks])
  const selectedIds = selected.map((t) => t.id)
  const selKey = selectedIds.join(',')

  const onChange = useCallback(
    (ids: string[], tasks: Task[]) => {
      if (paying) return
      const next = new URLSearchParams(params)
      next.set('tasks', tasks.length ? tasks.map((t) => t.slug || t.id).join(',') : ids.join(','))
      setParams(next, { replace: true })
      setPay({ step: 'idle' })
      setPayError(null)
    },
    [params, setParams, paying],
  )

  // Quote: on selection change (debounced), and again before it expires.
  const agentId = agent?.id ?? null
  useEffect(() => {
    if (!agentId || !selKey) {
      setQuoteState({ status: 'idle' })
      return
    }
    let live = true
    const t = setTimeout(() => {
      setQuoteState((s) => (s.status === 'ready' && s.key === selKey ? s : { status: 'loading' }))
      api
        .quote({ agentId, taskIds: selKey.split(',') })
        .then((quote) => live && setQuoteState({ status: 'ready', quote, key: selKey }))
        .catch((e: unknown) => live && setQuoteState({ status: 'error', message: quoteErrorMessage(e) }))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [agentId, selKey, quoteNonce])

  const quote = quoteState.status === 'ready' && quoteState.key === selKey ? quoteState.quote : null
  const leftMs = useCountdown(quote?.expiresAt ?? null)
  const payingRef = useRef(paying)
  payingRef.current = paying
  useEffect(() => {
    if (leftMs !== null && leftMs <= REQUOTE_MARGIN_MS && !payingRef.current) setQuoteNonce((n) => n + 1)
  }, [leftMs !== null && leftMs <= REQUOTE_MARGIN_MS]) // eslint-disable-line react-hooks/exhaustive-deps

  // Summary values.
  const n = selected.length
  const hiddenTests = selected.reduce((a, t) => a + (t.hiddenTestsCount ?? 0), 0)
  const estMin = selected.reduce((a, t) => a + (t.estMinutes ?? 0), 0)
  const model = models.find((m) => m.id === agent?.model)
  const modelLabel = model?.label ?? agent?.model ?? '—'
  const commit = commitOf(agent)
  const lamports = quote ? (quote.totalLamports ?? quote.amountLamports) : null
  const totalSol = lamports !== null ? lamports / LAMPORTS : null
  const totalUsd = quote ? (quote.totalUsd ?? quote.amountUsd) : null
  const itemized = quote?.tasks ?? []
  const allFallback = itemized.length > 0 && itemized.every((t) => t.estimateBasis === 'fallback')
  const modelEst = quote?.modelCostEstimateUsd ?? null
  const baseFeePerRun = itemized.find((t) => t.estimateBasis !== 'fallback')?.baseFeeUsd ?? null
  const insufficient = balance !== null && totalSol !== null && balance < totalSol + FEE_HEADROOM_SOL
  const canPay = n > 0 && Boolean(quote) && !paying && pay.step !== 'done' && !insufficient

  const onPay = async () => {
    if (!quote || !canPay) return
    setPayError(null)
    if (!wallet.connected || !wallet.publicKey) {
      setPayError('Connect your wallet to pay.')
      if (wallet.wallet) wallet.connect().catch(() => undefined)
      else walletModal.setVisible(true)
      return
    }
    if (session.wallet && wallet.publicKey.toBase58() !== session.wallet) {
      setPayError(`Switch your wallet to ${middle(session.wallet, 4, 4)} — the signed-in account.`)
      return
    }
    let q = quote
    if (Date.parse(q.expiresAt) - Date.now() < REQUOTE_MARGIN_MS) {
      try {
        setPay({ step: 'building' })
        q = await api.quote({ agentId: agentId!, taskIds: selectedIds })
        setQuoteState({ status: 'ready', quote: q, key: selKey })
      } catch (e) {
        setPay({ step: 'idle' })
        setPayError(quoteErrorMessage(e))
        return
      }
    }
    try {
      const created = await payQuote(q, wallet, connection, (step) => setPay({ step }))
      setPay({ step: 'done', txSig: created.txSig ?? '', evaluationId: created.evaluationId })
      setTimeout(() => navigate(`/evaluations/${created.evaluationId}`), 900)
    } catch (e) {
      setPay({ step: 'idle' })
      const err = e instanceof PayError ? e : new PayError('api', e instanceof Error ? e.message : String(e))
      setPayError(err.message + (err.txSig ? ` (tx ${middle(err.txSig, 4, 4)})` : ''))
      if (err.code === 'quote_expired') setQuoteNonce((x) => x + 1)
    }
  }

  const agentName = agent?.name ?? (agentError ? 'Agent' : '…')
  const priceSource = quote?.priceSource === 'pyth' ? 'Pyth' : quote?.priceSource === 'coingecko' ? 'CoinGecko' : null
  const left = leftMs !== null ? `${Math.floor(leftMs / 60000)}:${String(Math.floor((leftMs % 60000) / 1000)).padStart(2, '0')}` : null

  return (
    <main className="tma-page tma-page--flow st-page" data-testid="select-tasks-page">
      <div className="st-head">
        <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: agentName, to: `/agents/${aid}` }, { label: 'New evaluation' }]} />
        <div className="st-head__row">
          <div className="st-head__titles">
            <h1 className="tma-h1">Select tasks</h1>
            <span className="st-head__sub">Each task is graded by hidden tests outside your agent's sandbox.</span>
          </div>
          <Stepper steps={STEPS} current={1} />
        </div>
      </div>

      <div className="st-grid">
        <TaskFilter variant="inline" mode="run" selected={selectedIds} onChange={onChange} />

        <aside className="st-summary" data-testid="evaluation-summary">
          <div className="st-summary__head">
            <span className="st-summary__title">Evaluation</span>
            <span className="st-mono st-muted" data-testid="summary-count">
              {plural(n, 'task')}
            </span>
          </div>
          <div className="st-kv">
            <span className="st-k">Agent</span>
            <span className="st-v" data-testid="summary-agent">
              {agentError ? <span className="st-danger">{agentError}</span> : agentName} {commit && <span className="st-mono st-muted">{commit.slice(0, 7)}</span>}
            </span>
            <span className="st-k">Model</span>
            <span className="st-v">{modelLabel}</span>
            <span className="st-k">Hidden tests</span>
            <span className="st-v st-mono">{n ? hiddenTests : '—'}</span>
            <span className="st-k">Est. time</span>
            <span className="st-v st-mono">{n ? `~${estMin} min` : '—'}</span>
            <span className="st-k">Fee</span>
            <span className="st-v st-mono st-muted" data-testid="summary-fee" title="Per run: the forecast model cost (TestMyAgent pays the tokens) + the base fee. Without a forecast, a flat price.">
              {!quote
                ? '—'
                : allFallback
                  ? `US${usd(itemized[0]?.priceUsd ?? 0)} × ${n} flat`
                  : `${modelEst ? `≈ ${usd(modelEst)} model + ` : ''}US${usd(baseFeePerRun ?? 0)} × ${n}`}
            </span>
          </div>
          <div className="st-total">
            <span className="st-k st-total__k">Total</span>
            <div className="st-total__v">
              <span className="st-total__sol" data-testid="summary-total">
                {totalSol !== null ? totalSol.toFixed(5) : quoteState.status === 'loading' ? '…' : '—'} <span className="st-total__unit">SOL</span>
              </span>
              <span className="st-mono st-muted">
                {quote && (
                  <span className="st-rate" data-testid="quote-validity" title={`SOL/USD ${quote.solUsdRate} from ${priceSource}; the quote is valid for 2 min and refreshes by itself.`}>
                    {priceSource} · {left} ·{' '}
                  </span>
                )}
                ≈ {totalUsd !== null ? usd(totalUsd) : '—'} USD
              </span>
            </div>
          </div>
          <div className="st-actions">
            {pay.step === 'idle' && (
              <button type="button" className="st-pay" data-testid="pay-and-start" disabled={!canPay} onClick={onPay}>
                Pay and start
              </button>
            )}
            {paying && (
              <div className="st-pending" data-testid="pay-pending">
                <span className="st-dot st-dot--live" />
                {pay.step === 'signing' ? 'Confirm in wallet…' : pay.step === 'building' ? 'Preparing payment…' : pay.step === 'confirming' ? 'Confirming payment…' : 'Starting evaluation…'}
              </div>
            )}
            {pay.step === 'done' && (
              <div className="st-done" data-testid="pay-done">
                <span className="tma-badge tma-badge--success">
                  <span className="tma-badge__dot" />
                  Confirmed
                </span>
                {pay.txSig && (
                  <a className="st-mono st-muted" href={explorerTxUrl(pay.txSig)} target="_blank" rel="noreferrer">
                    tx {middle(pay.txSig, 4, 4)}
                  </a>
                )}
              </div>
            )}
            {quoteState.status === 'error' && n > 0 && (
              <span className="st-error" role="alert" data-testid="quote-error">
                {quoteState.message}{' '}
                <Button variant="text" onClick={() => setQuoteNonce((x) => x + 1)}>
                  Try again
                </Button>
              </span>
            )}
            {insufficient && pay.step === 'idle' && (
              <span className="st-error" role="alert" data-testid="insufficient-balance">
                Insufficient balance: this evaluation needs {totalSol!.toFixed(5)} SOL plus the network fee.
              </span>
            )}
            {payError && (
              <span className="st-error" role="alert" data-testid="pay-error">
                {payError}
              </span>
            )}
            <span className="st-foot">
              Balance <span className="st-mono st-text">{balance !== null ? `${balance.toFixed(4)} SOL` : '—'}</span> · fee covers compute, never the result.
            </span>
          </div>
        </aside>
      </div>
      {agentError && (
        <p className="st-foot">
          <Link to="/agents">Back to agents</Link>
        </p>
      )}
    </main>
  )
}
