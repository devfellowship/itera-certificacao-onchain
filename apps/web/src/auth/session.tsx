/**
 * Wallet session: Solana wallet-adapter connect + Sign-In With Solana against the API
 * (POST /auth/nonce → wallet.signMessage → POST /auth/verify → Bearer token, 24 h).
 * The token lives in localStorage per wallet so a reload keeps the session.
 *
 * In fixture mode (VITE_FIXTURE_MODE=design, U2) the session is a fixed design user and no wallet
 * is needed, so every page renders without the API.
 */
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { PublicKey } from '@solana/web3.js'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, setSessionToken, setUnauthorizedHandler } from '../lib/api'
import type { Me } from '../lib/api'
import { initialsOf } from '../tma/ui'
import { FIXTURE_MODE, FIXTURE_USER } from './fixture'

const STORAGE_KEY = 'tma.session'

interface StoredSession {
  wallet: string
  token: string
  expiresAt: string
}

export type SessionStatus = 'disconnected' | 'connecting' | 'signing' | 'signed-in' | 'error'

export interface Session {
  status: SessionStatus
  wallet: string | null
  walletName: string | null
  me: Me | null
  error: string | null
  /** Opens the wallet modal (if needed) and signs in. Resolves when signed in. */
  signIn: () => void
  signOut: () => Promise<void>
  /** U36: replaces the profile after the settings page saves it (no refetch). */
  setMe: (me: Me) => void
}

const SessionContext = createContext<Session | null>(null)

function readStored(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as StoredSession
    if (!s.token || new Date(s.expiresAt).getTime() <= Date.now() + 60_000) return null
    return s
  } catch {
    return null
  }
}
function writeStored(s: StoredSession | null) {
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // private mode: the session lives in memory only
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fallbackMe(wallet: string): Me {
  return { wallet, username: null, displayName: null, handle: null, avatarUrl: null, initials: initialsOf(wallet) }
}

function WalletSessionProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet()
  const modal = useWalletModal()
  const [stored, setStored] = useState<StoredSession | null>(() => readStored())
  const [status, setStatus] = useState<SessionStatus>(() => (readStored() ? 'signed-in' : 'disconnected'))
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const wantSignIn = useRef(false)
  const address = wallet.publicKey?.toBase58() ?? null

  // Install the token before any child effect fires a request.
  setSessionToken(stored?.token ?? null)

  const clear = useCallback(() => {
    writeStored(null)
    setStored(null)
    setMe(null)
    setSessionToken(null)
    setStatus('disconnected')
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(clear)
    return () => setUnauthorizedHandler(null)
  }, [clear])

  // A wallet switch in the extension invalidates the session of the previous wallet.
  useEffect(() => {
    if (stored && address && address !== stored.wallet) clear()
  }, [address, stored, clear])

  const doSiws = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signMessage) {
      setError('This wallet cannot sign messages.')
      setStatus('error')
      return
    }
    const addr = wallet.publicKey.toBase58()
    try {
      setStatus('signing')
      setError(null)
      const { message } = await api.authNonce(addr)
      const signature = await wallet.signMessage(new TextEncoder().encode(message))
      const res = await api.authVerify(addr, toBase64(signature))
      const s = { wallet: res.wallet, token: res.token, expiresAt: res.expiresAt }
      writeStored(s)
      setStored(s)
      setSessionToken(s.token)
      setStatus('signed-in')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [wallet])

  // autoConnect=false: picking a wallet in the modal only selects it. Connect it here, once.
  useEffect(() => {
    if (wantSignIn.current && wallet.wallet && !wallet.connected && !wallet.connecting) {
      wallet.connect().catch((e: unknown) => {
        wantSignIn.current = false
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      })
    }
  }, [wallet.wallet, wallet.connected, wallet.connecting]) // eslint-disable-line react-hooks/exhaustive-deps

  // Continue the sign-in once the modal connected a wallet.
  useEffect(() => {
    if (wantSignIn.current && wallet.connected && wallet.publicKey) {
      wantSignIn.current = false
      void doSiws()
    }
  }, [wallet.connected, wallet.publicKey, doSiws])

  const signIn = useCallback(() => {
    if (stored) return
    if (wallet.connected && wallet.publicKey) {
      void doSiws()
      return
    }
    wantSignIn.current = true
    setStatus('connecting')
    if (wallet.wallet) {
      wallet.connect().catch((e: unknown) => {
        wantSignIn.current = false
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      })
    } else {
      modal.setVisible(true)
    }
  }, [stored, wallet, doSiws, modal])

  // If the modal closes without a wallet, drop back to disconnected.
  useEffect(() => {
    if (!modal.visible && status === 'connecting' && !wallet.connecting && !wallet.connected && !wallet.wallet) {
      wantSignIn.current = false
      setStatus('disconnected')
    }
  }, [modal.visible, status, wallet.connecting, wallet.connected, wallet.wallet])

  const signOut = useCallback(async () => {
    clear()
    try {
      await wallet.disconnect()
    } catch {
      // already disconnected
    }
  }, [clear, wallet])

  // Profile (GET /me arrives with U5; until then fall back to the wallet initials).
  useEffect(() => {
    if (!stored) return
    let live = true
    api
      .me()
      .then((m) => live && setMe(m))
      .catch(() => live && setMe(fallbackMe(stored.wallet)))
    return () => {
      live = false
    }
  }, [stored])

  const value = useMemo<Session>(
    () => ({
      status,
      wallet: stored?.wallet ?? null,
      walletName: wallet.wallet?.adapter.name ?? null,
      me: me ?? (stored ? fallbackMe(stored.wallet) : null),
      error,
      signIn,
      signOut,
      setMe,
    }),
    [status, stored, wallet.wallet, me, error, signIn, signOut],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

function FixtureSessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me>(FIXTURE_USER)
  const value = useMemo<Session>(
    () => ({
      status: 'signed-in',
      wallet: FIXTURE_USER.wallet,
      walletName: 'Phantom',
      me,
      error: null,
      signIn: () => undefined,
      signOut: async () => undefined,
      setMe,
    }),
    [me],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function SessionProvider({ children }: { children: ReactNode }) {
  return FIXTURE_MODE ? <FixtureSessionProvider>{children}</FixtureSessionProvider> : <WalletSessionProvider>{children}</WalletSessionProvider>
}

export function useSession(): Session {
  const s = useContext(SessionContext)
  if (!s) throw new Error('useSession must be used inside <SessionProvider>')
  return s
}

/** SOL balance of the session wallet from the client RPC (4 decimals in the nav). Null while loading. */
export function useSolBalance(): number | null {
  const { connection } = useConnection()
  const { wallet } = useSession()
  const [balance, setBalance] = useState<number | null>(FIXTURE_MODE ? FIXTURE_USER.balanceSol : null)
  // U37: the faucet fires BALANCE_REFRESH_EVENT after a grant; every balance on screen reloads.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    window.addEventListener(BALANCE_REFRESH_EVENT, bump)
    return () => window.removeEventListener(BALANCE_REFRESH_EVENT, bump)
  }, [])
  useEffect(() => {
    if (FIXTURE_MODE || !wallet) return
    let live = true
    Promise.resolve()
      .then(() => connection.getBalance(new PublicKey(wallet)))
      .then((lamports) => live && setBalance(lamports / 1_000_000_000))
      .catch(() => live && setBalance(null))
    return () => {
      live = false
    }
  }, [connection, wallet, tick])
  return balance
}

/** U37: dispatch on window to make every useSolBalance() reload (after a faucet grant). */
export const BALANCE_REFRESH_EVENT = 'tma:balance-refresh'
export function refreshSolBalance() {
  window.dispatchEvent(new Event(BALANCE_REFRESH_EVENT))
}
