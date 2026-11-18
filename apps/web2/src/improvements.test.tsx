// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDflToken, jwtExpiry, loadDflToken, saveDflToken } from './auth/dflToken'
import { SESSION_KEY } from './auth/sessionStorage'
import { createImprovementsClient, draftError, isAllowedMediaUrl, pastedImages, buildPayload, type ImprovementsClient } from './improvements/client'
import { routes } from './routes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const jwt = (expSec: number) => `${b64({ alg: 'none' })}.${b64({ exp: expSec })}.sig`
const inOneHour = () => Math.floor(Date.now() / 1000) + 3600
const USER = { id: 'dfl:11111111-1111-1111-1111-111111111111', email: 'ana@example.com' }

// jsdom's AbortSignal is not Node's: same test-only shim as auth.test.tsx.
const NodeRequest = globalThis.Request
class TestRequest extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {}
    super(input, rest)
  }
}

let root: Root | undefined
beforeEach(() => {
  vi.stubGlobal('Request', TestRequest)
  // The session provider reads GET /me. A real request would answer 401 to a fake token later and sign the user out
  // in a following test, so every fetch of the page is stubbed. The launcher tests inject their own client.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

function fakeClient(over: Partial<ImprovementsClient> = {}): ImprovementsClient {
  return {
    isSuperadmin: vi.fn(async () => true),
    uploadImage: vi.fn(async () => 'https://media.devfellowship.com/abc'),
    submit: vi.fn(async () => ({ thread_url: 'https://example.com/t/1' })),
    listMine: vi.fn(async () => []),
    ...over,
  }
}

async function mountLauncher(path: string, client: ImprovementsClient) {
  // A page route plus the real root route: the launcher is mounted by `routes`, so mount the real table and inject the client.
  const { ImprovementsLauncher } = await import('./improvements/ImprovementsLauncher')
  const { SessionProvider } = await import('./auth/session')
  const { Outlet } = await import('react-router-dom')
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const router = createMemoryRouter(
    [
      {
        element: (
          <SessionProvider>
            <Outlet />
            <ImprovementsLauncher client={client} />
          </SessionProvider>
        ),
        children: [{ path: '*', element: <p>page</p> }],
      },
    ],
    { initialEntries: [path] },
  )
  act(() => root!.render(<RouterProvider router={router} />))
  await flush()
  return { container, router }
}

function signIn() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token: 'tma-session', user: USER }))
}
const fab = () => document.querySelector('[data-testid=improvements-launcher]') as HTMLButtonElement | null

describe('dflToken', () => {
  it('reads exp, drops an expired token, keeps a fresh one', () => {
    expect(jwtExpiry(jwt(1234))).toBe(1234)
    expect(jwtExpiry('not-a-jwt')).toBeNull()
    saveDflToken(jwt(inOneHour()))
    expect(loadDflToken()).not.toBeNull()
    clearDflToken()
    expect(loadDflToken()).toBeNull()
    saveDflToken(jwt(Math.floor(Date.now() / 1000) - 5))
    expect(loadDflToken()).toBeNull()
    expect(sessionStorage.getItem('tma2.dfl_token')).toBeNull()
    saveDflToken('garbage')
    expect(loadDflToken()).toBeNull()
  })
})

describe('client', () => {
  const token = jwt(inOneHour())
  it('sends the DFL JWT as bearer, with the testmyagent slug', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ thread_id: 't' }), { status: 201 }))
    const client = createImprovementsClient({ getToken: () => token, fetchImpl: fetchImpl as unknown as typeof fetch })
    await client.submit(buildPayload('  oi  ', [], window))
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://improvements-api.devfellowship.com/v1/requests')
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`)
    const body = JSON.parse(String(init.body))
    expect(body.app_slug).toBe('testmyagent')
    expect(body.text).toBe('oi')
  })
  it('isSuperadmin: 200 true, 403 false, no token false (no request), network error false', async () => {
    const mk = (status: number | 'throw', tok: string | null = token) => {
      const fetchImpl = vi.fn(async () => {
        if (status === 'throw') throw new Error('net')
        return new Response('{}', { status })
      })
      return { fetchImpl, client: createImprovementsClient({ getToken: () => tok, fetchImpl: fetchImpl as unknown as typeof fetch }) }
    }
    expect(await mk(200).client.isSuperadmin()).toBe(true)
    expect(await mk(403).client.isSuperadmin()).toBe(false)
    expect(await mk(401).client.isSuperadmin()).toBe(false)
    expect(await mk('throw').client.isSuperadmin()).toBe(false)
    const none = mk(200, null)
    expect(await none.client.isSuperadmin()).toBe(false)
    expect(none.fetchImpl).not.toHaveBeenCalled()
  })
  it('submit maps 403 to a message and uploads only accept media.devfellowship.com', async () => {
    const f403 = vi.fn(async () => new Response('{}', { status: 403 }))
    await expect(createImprovementsClient({ getToken: () => token, fetchImpl: f403 as unknown as typeof fetch }).submit(buildPayload('x', [], window))).rejects.toThrow(/superadmins/)
    const evil = vi.fn(async () => new Response(JSON.stringify({ url: 'https://evil.example/x.png' }), { status: 200 }))
    const small = new File(['x'], 'a.png', { type: 'image/png' })
    await expect(createImprovementsClient({ getToken: () => token, fetchImpl: evil as unknown as typeof fetch }).uploadImage(small)).rejects.toThrow(/media/)
    const good = vi.fn(async () => new Response(JSON.stringify({ url: 'https://media.devfellowship.com/id1' }), { status: 200 }))
    const url = await createImprovementsClient({ getToken: () => token, fetchImpl: good as unknown as typeof fetch }).uploadImage(small)
    expect(url).toBe('https://media.devfellowship.com/id1')
    const [target, init] = good.mock.calls[0] as unknown as [string, RequestInit]
    expect(target).toBe('https://yoojxnggaxcqtsyjdrdx.supabase.co/functions/v1/upload-file')
    expect((init.body as FormData).get('visibility')).toBe('members')
  })
  it('draft rules', () => {
    expect(draftError('  ', [])).toMatch(/Descreva/)
    expect(draftError('ok', ['http://media.devfellowship.com/a'])).toMatch(/media/)
    expect(draftError('ok', ['https://media.devfellowship.com/a'])).toBeNull()
    expect(isAllowedMediaUrl('https://media.devfellowship.com.evil.io/a')).toBe(false)
    expect(pastedImages(null)).toEqual([])
  })
})

describe('launcher', () => {
  it('shows the button for a signed-in superadmin with a fresh DFL token (positive control)', async () => {
    signIn()
    saveDflToken(jwt(inOneHour()))
    const client = fakeClient()
    await mountLauncher('/agents', client)
    expect(client.isSuperadmin).toHaveBeenCalledTimes(1)
    expect(fab()).not.toBeNull()
    expect(localStorage.getItem('tma2.melhorias.superadmin')).toBe(USER.id)
  })
  it('hides for a non-superadmin and forgets the hint', async () => {
    signIn()
    saveDflToken(jwt(inOneHour()))
    localStorage.setItem('tma2.melhorias.superadmin', USER.id)
    await mountLauncher('/agents', fakeClient({ isSuperadmin: vi.fn(async () => false) }))
    expect(fab()).toBeNull()
    expect(localStorage.getItem('tma2.melhorias.superadmin')).toBeNull()
  })
  it('hides when signed out, and with no token and no hint (no service call)', async () => {
    const client = fakeClient()
    await mountLauncher('/', client)
    expect(fab()).toBeNull()
    document.body.innerHTML = ''
    act(() => root?.unmount())
    signIn()
    const client2 = fakeClient()
    await mountLauncher('/agents', client2)
    expect(fab()).toBeNull()
    expect(client2.isSuperadmin).not.toHaveBeenCalled()
  })
  it('hides on the login and callback pages', async () => {
    signIn()
    saveDflToken(jwt(inOneHour()))
    await mountLauncher('/auth/dfl/callback', fakeClient())
    expect(fab()).toBeNull()
  })
  it('opens the dialog, sends one request, shows the thread link', async () => {
    signIn()
    saveDflToken(jwt(inOneHour()))
    const client = fakeClient()
    await mountLauncher('/agents', client)
    act(() => fab()!.click())
    const dialog = document.querySelector('[data-testid=improvements-dialog]')
    expect(dialog).not.toBeNull()
    const text = document.querySelector('[data-testid=improvements-text]') as HTMLTextAreaElement
    const submit = document.querySelector('[data-testid=improvements-submit]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      set.call(text, 'colocar um botao novo')
      text.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(submit.disabled).toBe(false)
    await act(async () => submit.click())
    await flush()
    expect(client.submit).toHaveBeenCalledTimes(1)
    const payload = (client.submit as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(payload).toMatchObject({ app_slug: 'testmyagent', text: 'colocar um botao novo', image_urls: [] })
    expect(document.querySelector('[data-testid=improvements-sent]')).not.toBeNull()
  })
  it('an expired token with the hint shows the button, and the click re-federates with the dialog flag', async () => {
    signIn()
    localStorage.setItem('tma2.melhorias.superadmin', USER.id)
    const client = fakeClient()
    await mountLauncher('/studio/review?judge=x', client)
    expect(fab()).not.toBeNull()
    expect(client.isSuperadmin).not.toHaveBeenCalled()
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { value: { ...original, assign, origin: 'https://testmyagent.com', pathname: '/studio/review', search: '?judge=x' }, configurable: true })
    act(() => fab()!.click())
    Object.defineProperty(window, 'location', { value: original, configurable: true })
    expect(assign).toHaveBeenCalledTimes(1)
    const target = String(assign.mock.calls[0][0])
    expect(target.startsWith('https://learn.devfellowship.com/auth/federate?return=')).toBe(true)
    const next = decodeURIComponent(target.split('&next=')[1])
    expect(next).toBe('/studio/review?judge=x&melhorias=open')
  })
  it('back from the re-login (?melhorias=open) opens the dialog once and strips the flag', async () => {
    signIn()
    saveDflToken(jwt(inOneHour()))
    const { router } = await mountLauncher('/agents?melhorias=open', fakeClient())
    await flush()
    expect(document.querySelector('[data-testid=improvements-dialog]')).not.toBeNull()
    expect(router.state.location.search).toBe('')
  })
})

describe('mount in the real route table', () => {
  it('the root route renders the launcher slot without breaking the landing page', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/'] })} />))
    await flush()
    expect(container.textContent?.length).toBeGreaterThan(50)
    expect(fab()).toBeNull()
  })
})
