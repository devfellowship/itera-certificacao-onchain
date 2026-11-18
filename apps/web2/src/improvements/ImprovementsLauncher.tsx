import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { loginWithDfl } from '../auth/dflFederation'
import { loadDflToken } from '../auth/dflToken'
import { useSession } from '../auth/session'
import { Button, Modal, Tabs, Textarea } from '../tma/ui'
import {
  IMPROVEMENT_MAX_IMAGES,
  buildPayload,
  createImprovementsClient,
  draftError,
  pastedImages,
  safeHttpUrl,
  statusLabel,
  type ImprovementRequestSummary,
  type ImprovementSubmitResult,
  type ImprovementsClient,
} from './client'
import './improvements.css'

/**
 * "Melhorias" (plan 20261103-in-app-improvements-melhorias): a superadmin asks for a change to
 * testmyagent.com from inside the app. One floating button opens one dialog. Mounted once, in the
 * root route (`routes.tsx`), so it shows on every page for a signed-in user.
 *
 * Who sees it: only a signed-in user whose DFL JWT passes the service gate (`GET /v1/requests?mine=1`
 * answers 200 for a superadmin, 403 for anyone else). The hiding is cosmetic: the service checks again.
 * The DFL JWT lives in this tab only and expires in about 1 h (`auth/dflToken.ts`). A superadmin whose
 * token expired still sees the button (a hint in localStorage); the click goes through Login with DFL
 * again (an instant redirect when the DFL session is alive) and comes back with the dialog open.
 */

const HINT_KEY = 'tma2.melhorias.superadmin'
/** Query flag that reopens the dialog after the re-login. */
export const REOPEN_PARAM = 'melhorias'

type Access = 'hidden' | 'ready' | 'reauth'

const readHint = (): string | null => {
  try {
    return localStorage.getItem(HINT_KEY)
  } catch {
    return null
  }
}
const writeHint = (userId: string | null) => {
  try {
    if (userId) localStorage.setItem(HINT_KEY, userId)
    else localStorage.removeItem(HINT_KEY)
  } catch {
    /* storage blocked: the hint is only a convenience */
  }
}

/** Paths with no launcher: the login pages (and the callback that holds the token fragment). */
const QUIET = /^\/(login|auth\/)/

function useAccess(client: ImprovementsClient, userId: string | null) {
  const [answer, setAnswer] = useState<{ userId: string; access: Access } | null>(null)
  useEffect(() => {
    if (!userId) return
    let live = true
    const settle = (access: Access) => live && setAnswer({ userId, access })
    if (loadDflToken()) {
      client.isSuperadmin().then(
        (ok) => {
          writeHint(ok ? userId : null)
          settle(ok ? 'ready' : 'hidden')
        },
        () => settle('hidden'),
      )
    } else {
      settle(readHint() === userId ? 'reauth' : 'hidden')
    }
    return () => {
      live = false
    }
  }, [client, userId])
  return userId !== null && answer?.userId === userId ? answer.access : 'hidden'
}

export function ImprovementsLauncher({ client: given }: { client?: ImprovementsClient }) {
  const { status, wallet } = useSession()
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const client = useMemo(() => given ?? createImprovementsClient({ getToken: () => loadDflToken() }), [given])
  const userId = status === 'signed-in' ? wallet : null
  const access = useAccess(client, userId)
  const [open, setOpen] = useState(false)

  const reauth = useCallback(() => {
    const params = new URLSearchParams(search)
    params.set(REOPEN_PARAM, 'open')
    loginWithDfl(`${pathname}?${params.toString()}`)
  }, [pathname, search])

  const onClick = useCallback(() => {
    // The token can expire while the page stays open: check at the click, not only at mount.
    if (loadDflToken()) setOpen(true)
    else reauth()
  }, [reauth])

  // Back from the re-login: open the dialog once and drop the flag from the URL.
  useEffect(() => {
    if (access !== 'ready') return
    const params = new URLSearchParams(search)
    if (params.get(REOPEN_PARAM) !== 'open') return
    params.delete(REOPEN_PARAM)
    const rest = params.toString()
    navigate({ pathname, search: rest ? `?${rest}` : '' }, { replace: true })
    setOpen(true)
  }, [access, pathname, search, navigate])

  if (access === 'hidden' || QUIET.test(pathname)) return null
  return (
    <>
      <button
        type="button"
        className="improvements-fab"
        data-testid="improvements-launcher"
        aria-label="Melhorias"
        title="Melhorias: pedir uma mudança neste app"
        onClick={onClick}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7.5 15.5h5M8 18h4M10 2.5a5 5 0 0 0-3 9c.6.5 1 1.2 1 2h4c0-.8.4-1.5 1-2a5 5 0 0 0-3-9Z" />
        </svg>
      </button>
      {open && <ImprovementsDialog client={client} onClose={() => setOpen(false)} />}
    </>
  )
}

interface Shot {
  id: number
  name: string
  preview: string
  status: 'uploading' | 'done' | 'error'
  url?: string
  error?: string
}

type Mine =
  | { status: 'loading'; items: ImprovementRequestSummary[] | null }
  | { status: 'ready'; items: ImprovementRequestSummary[] }
  | { status: 'error'; items: ImprovementRequestSummary[] | null; error: string }

const message = (error: unknown) => (error instanceof Error && error.message ? error.message : String(error))

export function ImprovementsDialog({ client, onClose }: { client: ImprovementsClient; onClose: () => void }) {
  const [view, setView] = useState<'new' | 'mine'>('new')
  const [text, setText] = useState('')
  const [shots, setShots] = useState<Shot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState<ImprovementSubmitResult | null>(null)
  const [mine, setMine] = useState<Mine>({ status: 'loading', items: null })
  const nextId = useRef(0)
  const live = useRef(true)
  const shotsRef = useRef(shots)
  shotsRef.current = shots
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      for (const shot of shotsRef.current) URL.revokeObjectURL(shot.preview)
    }
  }, [])

  const upload = useCallback(
    (files: File[]) => {
      const room = IMPROVEMENT_MAX_IMAGES - shotsRef.current.length
      if (room <= 0) {
        setError(`Máximo de ${IMPROVEMENT_MAX_IMAGES} imagens.`)
        return
      }
      for (const file of files.slice(0, room)) {
        const id = nextId.current++
        setShots((list) => [...list, { id, name: file.name || 'print', preview: URL.createObjectURL(file), status: 'uploading' }])
        client.uploadImage(file).then(
          (url) => live.current && setShots((list) => list.map((s) => (s.id === id ? { ...s, status: 'done', url } : s))),
          (reason: unknown) =>
            live.current && setShots((list) => list.map((s) => (s.id === id ? { ...s, status: 'error', error: message(reason) } : s))),
        )
      }
    },
    [client],
  )

  // Ctrl+V of a screenshot, only while the dialog is open.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = pastedImages(event.clipboardData)
      if (files.length === 0) return
      event.preventDefault()
      upload(files)
    }
    window.addEventListener('paste', onPaste, true)
    return () => window.removeEventListener('paste', onPaste, true)
  }, [upload])

  const loadMine = useCallback(async () => {
    setMine((prev) => ({ status: 'loading', items: prev.items }))
    try {
      const items = await client.listMine()
      if (live.current) setMine({ status: 'ready', items })
    } catch (reason) {
      if (live.current) setMine((prev) => ({ status: 'error', items: prev.items, error: message(reason) }))
    }
  }, [client])
  useEffect(() => {
    if (view === 'mine') void loadMine()
  }, [view, loadMine])

  const uploading = shots.some((shot) => shot.status === 'uploading')
  const failed = shots.find((shot) => shot.status === 'error')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const urls = shots.flatMap((shot) => (shot.url ? [shot.url] : []))
    const problem = draftError(text, urls)
    if (problem) {
      setError(problem)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await client.submit(buildPayload(text, urls, window))
      if (live.current) setSent(result ?? {})
    } catch (reason) {
      if (live.current) setError(message(reason))
    } finally {
      if (live.current) setSubmitting(false)
    }
  }

  const threadUrl = safeHttpUrl(sent?.thread_url)
  return (
    <Modal open onClose={onClose} title="Pedir uma melhoria" width={560} testId="improvements-dialog">
      <div className="improvements">
        <Tabs
          items={[
            { id: 'new', label: 'Nova melhoria' },
            { id: 'mine', label: 'Minhas melhorias' },
          ]}
          value={view}
          onChange={setView}
        />
        {view === 'mine' ? (
          <MineList state={mine} onRetry={() => void loadMine()} />
        ) : sent ? (
          <div className="improvements-form" data-testid="improvements-sent">
            <p>Melhoria enviada. Um agente vai responder no thread.</p>
            {threadUrl && (
              <a href={threadUrl} target="_blank" rel="noreferrer">
                Abrir o thread
              </a>
            )}
            <div className="improvements-actions">
              <Button variant="secondary" size={36} onClick={() => setView('mine')}>
                Ver minhas melhorias
              </Button>
              <Button variant="primary" size={36} onClick={onClose}>
                Fechar
              </Button>
            </div>
          </div>
        ) : (
          <form className="improvements-form" onSubmit={submit}>
            <p className="improvements-hint">Descreva o que você quer mudar nesta tela.</p>
            <Textarea
              data-testid="improvements-text"
              aria-label="Descrição da melhoria"
              placeholder="Ex.: o botão Salvar devia ficar no topo…"
              rows={5}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <p className="improvements-hint">Cole um print com Ctrl+V (até {IMPROVEMENT_MAX_IMAGES} imagens).</p>
            {shots.length > 0 && (
              <ul className="improvements-shots" data-testid="improvements-images">
                {shots.map((shot) => (
                  <li key={shot.id} data-status={shot.status} title={shot.error}>
                    <img src={shot.preview} alt={shot.name} />
                    {shot.status === 'uploading' && <span className="improvements-shot-state">…</span>}
                    <button
                      type="button"
                      aria-label="Remover imagem"
                      onClick={() => {
                        URL.revokeObjectURL(shot.preview)
                        setShots((list) => list.filter((s) => s.id !== shot.id))
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(error ?? failed?.error) && (
              <p role="alert" className="improvements-error">
                {error ?? failed?.error}
              </p>
            )}
            <div className="improvements-actions">
              <Button variant="secondary" size={36} onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" variant="primary" size={36} data-testid="improvements-submit" disabled={!text.trim() || uploading || submitting}>
                {submitting ? 'Enviando…' : 'Enviar'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  )
}

function MineList({ state, onRetry }: { state: Mine; onRetry: () => void }) {
  return (
    <div role="tabpanel" className="improvements-mine" data-testid="improvements-mine" data-status={state.status}>
      {state.status === 'error' && (
        <p role="alert" className="improvements-error">
          Não foi possível carregar suas melhorias. {state.error}{' '}
          <Button variant="text" size={30} onClick={onRetry}>
            Tentar de novo
          </Button>
        </p>
      )}
      {state.status === 'loading' && state.items === null && <p className="improvements-hint">Carregando suas melhorias…</p>}
      {state.status === 'ready' && state.items.length === 0 && <p className="improvements-hint">Você ainda não pediu nenhuma melhoria.</p>}
      {state.items && state.items.length > 0 && (
        <ul className="improvements-list" data-testid="improvements-mine-list">
          {state.items.map((item) => {
            const result = safeHttpUrl(item.result_url)
            return (
              <li key={item.thread_id}>
                <strong>{item.subject}</strong>
                <span className="improvements-hint">
                  Thread: {statusLabel(item.thread_status)} · Tarefa:{' '}
                  {item.task ? `${item.task.identifier ?? ''} ${statusLabel(item.task.status)}`.trim() : 'sem tarefa'}
                </span>
                {result && (
                  <a href={result} target="_blank" rel="noreferrer">
                    Ver resultado
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
