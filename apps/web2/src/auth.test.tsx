// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeInternalPath } from './auth/safeInternalPath'
import { SessionProvider, useSession } from './auth/session'
import { SESSION_KEY } from './auth/sessionStorage'
import { buildFederateUrl, DEFAULT_API_URL } from './config'
import { routes } from './routes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SECRET_DFL = 'dfl-secret-jwt-AAA.BBB.CCC'
const SECRET_SESSION = 'tma-session-secret-XYZ'
const USER = { id: 'dfl:123', email: 'ana@example.com' }

// jsdom's AbortSignal is not Node's, so the router's internal `new Request(url, {signal})` throws in the data
// router on a navigate. This test-only shim drops the signal. It touches no production code.
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
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}

function mountApp(path: string) {
  return mount(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />)
}

/** Calls to the API, without the session's own GET /me profile read. */
const apiCalls = (m: { mock: { calls: unknown[][] } }) =>
  (m.mock.calls as unknown as Array<[string, RequestInit]>).filter(([u]) => !String(u).endsWith('/me'))
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

function spyConsole() {
  return (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
}
function consoleText(spies: ReturnType<typeof spyConsole>) {
  return JSON.stringify(spies.flatMap((s) => s.mock.calls.map((c) => c.map(String))))
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('DFL callback', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', `/auth/dfl/callback#dfl_token=${SECRET_DFL}&next=/runs`)
  })

  it('clears the hash before the network call, exchanges the token, stores the session and navigates', async () => {
    const spies = spyConsole()
    let hashAtFetch: string | undefined
    const fetchMock = vi.fn(async () => {
      hashAtFetch = window.location.hash
      return json(200, { sessionToken: SECRET_SESSION, user: USER })
    })
    vi.stubGlobal('fetch', fetchMock)
    const container = mountApp('/auth/dfl/callback')
    await flush()

    expect(hashAtFetch).toBe('')
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(SECRET_DFL)
    expect(apiCalls(fetchMock)).toHaveLength(1)
    const [url, init] = apiCalls(fetchMock)[0]!
    expect(url).toBe(`${DEFAULT_API_URL}/auth/dfl/exchange`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ dflToken: SECRET_DFL })

    expect(JSON.parse(localStorage.getItem(SESSION_KEY)!)).toEqual({ token: SECRET_SESSION, user: USER })
    // next=/runs is not a route: the not-found page shows.
    expect(container.textContent).toContain('Page not found')

    const text = consoleText(spies)
    expect(text).not.toContain(SECRET_DFL)
    expect(text).not.toContain(SECRET_SESSION)
  })

  it('navigates to / when next is missing or unsafe', async () => {
    window.history.replaceState(null, '', `/auth/dfl/callback#dfl_token=${SECRET_DFL}&next=//evil.example`)
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { sessionToken: SECRET_SESSION, user: USER })))
    const container = mountApp('/auth/dfl/callback')
    await flush()
    expect(container.textContent).toContain('Signed in as ana@example.com')
  })

  it.each([501, 500, 401, 403])('shows the error state with a try-again button on exchange status %i', async (status) => {
    const spies = spyConsole()
    vi.stubGlobal('fetch', vi.fn(async () => json(status, { error: 'nope' })))
    const container = mountApp('/auth/dfl/callback')
    await flush()
    expect(container.querySelector('[data-testid="dfl-callback-error"]')).not.toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
    expect(window.location.hash).toBe('')
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="dfl-callback-retry"]')!
    expect(retry.textContent).toBe('Try again')
    expect(consoleText(spies)).not.toContain(SECRET_DFL)
  })

  it('shows the error state on a network failure and on a missing token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const container = mountApp('/auth/dfl/callback')
    await flush()
    expect(container.querySelector('[data-testid="dfl-callback-error"]')).not.toBeNull()

    act(() => root?.unmount())
    document.body.innerHTML = ''
    window.history.replaceState(null, '', '/auth/dfl/callback')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const c2 = mountApp('/auth/dfl/callback')
    await flush()
    expect(c2.querySelector('[data-testid="dfl-callback-error"]')).not.toBeNull()
    expect(apiCalls(fetchMock)).toHaveLength(0)
  })

  it('shows the error state when the 200 body is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { sessionToken: 5 })))
    const container = mountApp('/auth/dfl/callback')
    await flush()
    expect(container.querySelector('[data-testid="dfl-callback-error"]')).not.toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('the try-again button sends the browser to the federate URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(501, {})))
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
      hash: '',
      origin: 'http://localhost:3000',
    } as unknown as Location)
    const container = mountApp('/auth/dfl/callback')
    await flush()
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="dfl-callback-retry"]')!.click())
    expect(assign).toHaveBeenCalledWith(buildFederateUrl('http://localhost:3000'))
  })
})

describe('session', () => {
  function Probe({ onReady }: { onReady: (s: ReturnType<typeof useSession>) => void }) {
    const s = useSession()
    onReady(s)
    return <span data-testid="who">{s.user?.email ?? 'anon'}</span>
  }

  it('loads the stored session, sends the bearer token and keeps the session on 200', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: SECRET_SESSION, user: USER }))
    const fetchMock = vi.fn(async () => json(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const redirect = vi.fn()
    let ctx!: ReturnType<typeof useSession>
    const c = mount(<SessionProvider redirect={redirect} apiUrl="https://api.test"><Probe onReady={(s) => (ctx = s)} /></SessionProvider>)
    expect(c.textContent).toBe(USER.email)
    await act(async () => { await ctx.apiFetch('/runs') })
    const [url, init] = apiCalls(fetchMock)[0]!
    expect(url).toBe('https://api.test/runs')
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${SECRET_SESSION}`)
    expect(redirect).not.toHaveBeenCalled()
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull()
  })

  it('on 401 clears the session and sends the browser to the federate URL', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: SECRET_SESSION, user: USER }))
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'expired' })))
    const redirect = vi.fn()
    let ctx!: ReturnType<typeof useSession>
    const c = mount(<SessionProvider redirect={redirect} apiUrl="https://api.test"><Probe onReady={(s) => (ctx = s)} /></SessionProvider>)
    window.history.replaceState(null, '', '/runs?x=1')
    let res!: Response
    await act(async () => { res = await ctx.apiFetch('/runs') })
    expect(res.status).toBe(401)
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
    expect(c.textContent).toBe('anon')
    expect(redirect).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenCalledWith(buildFederateUrl(window.location.origin, undefined, '/runs?x=1'))
    expect(redirect.mock.calls[0]![0]).toContain('next=%2Fruns%3Fx%3D1')
  })

  it('logout clears the session and the nav shows the login button again', () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: SECRET_SESSION, user: USER }))
    const c = mountApp('/agents')
    expect(c.querySelector('[data-testid="nav-user-email"]')?.textContent).toBe(USER.email)
    expect(c.querySelector('[data-testid="login-dfl"]')).toBeNull()
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="nav-logout"]')!.click())
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
    expect(c.querySelectorAll('[data-testid="login-dfl"]')).toHaveLength(1)
  })

  it('works when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const c = mountApp('/')
    expect(c.querySelectorAll('[data-testid="login-dfl"]')).toHaveLength(1)
  })

  it('useSession outside the provider throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => mount(<Probe onReady={() => {}} />)).toThrow(/SessionProvider/)
  })
})

describe('safeInternalPath', () => {
  it.each([
    ['/runs', '/runs'],
    ['/a?b=1', '/a?b=1'],
    ['//evil.example', '/'],
    ['https://evil.example', '/'],
    ['/\\evil', '/'],
    ['', '/'],
    [null, '/'],
  ])('%s -> %s', (input, out) => {
    expect(safeInternalPath(input)).toBe(out)
  })
})
