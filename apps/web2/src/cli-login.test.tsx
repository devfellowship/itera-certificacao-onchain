// @vitest-environment jsdom
// The /cli approve page of `tma login` (task L5): code from the URL, Allow, Deny, closed codes, errors,
// the session gate, and no device code or CLI token on the page.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_KEY } from './auth/sessionStorage'
import { normalizeUserCode } from './pages/CliLoginPage'
import { routes } from './routes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
})

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function signIn() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token: 'web-session-token', user: { id: 'dfl:123', email: 'ana@example.com' } }))
}

function mountApp(path: string) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />))
  return container
}

type Call = [string, RequestInit | undefined]
/** API calls, without the session's own GET /me read. */
const apiCalls = (m: { mock: { calls: unknown[][] } }) => (m.mock.calls as unknown as Call[]).filter(([u]) => !String(u).endsWith('/me'))

function fakeApi(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    if (path === '/me') return json(404, { error: 'not_found' })
    const key = `${init?.method ?? 'GET'} ${path}`
    const h = handlers[key]
    if (!h) throw new Error(`unexpected ${key}`)
    return h(init)
  })
}

const click = (el: Element | null) => act(() => (el as HTMLElement).click())

describe('normalizeUserCode', () => {
  it('accepts the three spellings and refuses the rest', () => {
    expect(normalizeUserCode('abcd efgh')).toBe('ABCD-EFGH')
    expect(normalizeUserCode('ABCDEFGH')).toBe('ABCD-EFGH')
    expect(normalizeUserCode('abcd-efgh')).toBe('ABCD-EFGH')
    expect(normalizeUserCode('ABC')).toBeNull()
    expect(normalizeUserCode('ABCD-EFG!')).toBeNull()
    expect(normalizeUserCode(null)).toBeNull()
  })
})

describe('/cli approve page', () => {
  it('asks for a Login with DFL session first', async () => {
    const fetchMock = fakeApi({})
    vi.stubGlobal('fetch', fetchMock)
    const c = mountApp('/cli?code=ABCD-EFGH')
    await flush()
    expect(c.querySelector('[data-testid="require-session"]')).not.toBeNull()
    expect(apiCalls(fetchMock)).toHaveLength(0)
  })

  it('shows the request, Allow approves it with the web session, and the page shows no secret', async () => {
    signIn()
    const fetchMock = fakeApi({
      'GET /auth/cli/requests/ABCD-EFGH': () => json(200, { user_code: 'ABCD-EFGH', client_name: 'tma 0.1.0 on samuel-vps', state: 'pending' }),
      'POST /auth/cli/approve': () => json(200, { user_code: 'ABCD-EFGH', client_name: 'tma 0.1.0 on samuel-vps', state: 'approved' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = mountApp('/cli?code=abcd-efgh')
    await flush()
    expect(c.querySelector('[data-testid="cli-user-code"]')?.textContent).toBe('ABCD-EFGH')
    expect(c.querySelector('[data-testid="cli-client-name"]')?.textContent).toBe('tma 0.1.0 on samuel-vps')
    await click(c.querySelector('[data-testid="cli-allow"]'))
    await flush()
    expect(c.querySelector('[data-testid="cli-approved"]')).not.toBeNull()
    const calls = apiCalls(fetchMock)
    const approve = calls.find(([u, i]) => u.endsWith('/auth/cli/approve') && i?.method === 'POST')!
    expect(JSON.parse(String(approve[1]!.body))).toEqual({ user_code: 'ABCD-EFGH' })
    expect(new Headers(approve[1]!.headers).get('Authorization')).toBe('Bearer web-session-token')
    expect(c.innerHTML).not.toContain('web-session-token')
    expect(calls.some(([u]) => u.includes('/auth/cli/token'))).toBe(false)
  })

  it('Deny closes the request', async () => {
    signIn()
    const fetchMock = fakeApi({
      'GET /auth/cli/requests/ABCD-EFGH': () => json(200, { user_code: 'ABCD-EFGH', client_name: null, state: 'pending' }),
      'POST /auth/cli/deny': () => json(200, { user_code: 'ABCD-EFGH', client_name: null, state: 'denied' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = mountApp('/cli?code=ABCD-EFGH')
    await flush()
    await click(c.querySelector('[data-testid="cli-deny"]'))
    await flush()
    expect(c.querySelector('[data-testid="cli-denied"]')).not.toBeNull()
    expect(apiCalls(fetchMock).some(([u]) => u.endsWith('/auth/cli/approve'))).toBe(false)
  })

  it('a closed code shows no Allow button', async () => {
    signIn()
    vi.stubGlobal('fetch', fakeApi({ 'GET /auth/cli/requests/ABCD-EFGH': () => json(200, { user_code: 'ABCD-EFGH', client_name: null, state: 'expired' }) }))
    const c = mountApp('/cli?code=ABCD-EFGH')
    await flush()
    expect(c.querySelector('[data-testid="cli-allow"]')).toBeNull()
    expect(c.querySelector('[data-testid="cli-closed"]')?.textContent).toContain('expired')
  })

  it('an unknown code shows the error', async () => {
    signIn()
    vi.stubGlobal('fetch', fakeApi({ 'GET /auth/cli/requests/ZZZZ-9999': () => json(404, { error: 'code_not_found' }) }))
    const c = mountApp('/cli?code=ZZZZ-9999')
    await flush()
    expect(c.querySelector('[data-testid="cli-error"]')?.textContent).toContain('No login request has this code')
  })

  it('without a code in the URL, the typed code loads the request', async () => {
    signIn()
    const fetchMock = fakeApi({
      'GET /auth/cli/requests/ABCD-EFGH': () => json(200, { user_code: 'ABCD-EFGH', client_name: null, state: 'pending' }),
      'POST /auth/cli/approve': () => json(409, { error: 'code_already_used' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = mountApp('/cli')
    await flush()
    const input = c.querySelector('[data-testid="cli-code-input"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'abcd efgh')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(c.querySelector('[data-testid="cli-code-submit"]'))
    await flush()
    expect(c.querySelector('[data-testid="cli-user-code"]')?.textContent).toBe('ABCD-EFGH')
    await click(c.querySelector('[data-testid="cli-allow"]'))
    await flush()
    expect(c.querySelector('[data-testid="cli-error"]')?.textContent).toContain('already approved or denied')
  })
})
