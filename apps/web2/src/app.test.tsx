// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { buildFederateUrl, DEFAULT_API_URL, DEFAULT_FEDERATE_URL } from './config'
import { LoginButton } from './pages/LoginButton'
import { routes } from './routes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
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

describe('apps/web2', () => {
  it('builds the exact federate URL with the encoded return', () => {
    expect(buildFederateUrl('https://app.example.com')).toBe(
      'https://learn.devfellowship.com/auth/federate?return=https%3A%2F%2Fapp.example.com%2Fauth%2Fdfl%2Fcallback&next=/',
    )
    expect(buildFederateUrl('http://localhost:5174', 'https://x.test/f')).toBe(
      'https://x.test/f?return=http%3A%2F%2Flocalhost%3A5174%2Fauth%2Fdfl%2Fcallback&next=/',
    )
  })

  it('has the documented defaults', () => {
    expect(DEFAULT_FEDERATE_URL).toBe('https://learn.devfellowship.com/auth/federate')
    expect(DEFAULT_API_URL).toBe('https://itera-agent-credentials-api.devfellowship.com')
  })

  it('mounts the landing page with a non-empty root and one login button', () => {
    const container = mountApp('/')
    expect(container.innerHTML).not.toBe('')
    expect(container.textContent).toContain('Show buyers what your coding agent can do')
    const buttons = container.querySelectorAll('[data-testid="login-dfl"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toBe('Login with DFL')
  })

  it('renders the login button on /login', () => {
    const container = mountApp('/login')
    expect(container.querySelector('[data-testid="login-dfl"]')?.textContent).toBe('Login with DFL')
  })

  it('sends the browser to the federate URL on click', () => {
    const navigate = vi.fn()
    const container = mount(<LoginButton navigate={navigate} />)
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="login-dfl"]')!.click()
    })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith(buildFederateUrl(window.location.origin))
    expect(navigate.mock.calls[0]![0]).toContain(
      `return=${encodeURIComponent(`${window.location.origin}/auth/dfl/callback`)}&next=/`,
    )
  })
})

describe('UI foundation: AppNav and the session gate', () => {
  const mountRoutes = (path: string) => {
    const c = document.createElement('div')
    document.body.appendChild(c)
    const root = createRoot(c)
    act(() => root.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />))
    return { c, root }
  }

  afterEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('signed in: AppNav shows the email and no SOL text', () => {
    saveSession({ token: 'tok', user: { id: 'u-1', email: 'ana@example.com' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    const { c, root } = mountRoutes('/agents')
    expect(c.querySelectorAll('[data-testid="app-nav"]')).toHaveLength(1)
    expect(c.querySelector('[data-testid="nav-user-email"]')?.textContent).toBe('ana@example.com')
    for (const id of ['nav-agents', 'nav-tasks', 'nav-my-evaluations']) expect(c.querySelector(`[data-testid="${id}"]`)).not.toBeNull()
    expect(c.textContent).not.toContain('SOL')
    expect(c.querySelector('[data-testid="require-session"]')).toBeNull()
    act(() => root.unmount())
  })

  it('signed out: /agents shows the login gate', () => {
    const { c, root } = mountRoutes('/agents')
    expect(c.querySelector('[data-testid="require-session-login"]')?.textContent).toBe('Login with DFL')
    expect(c.querySelector('[data-testid="nav-user-email"]')).toBeNull()
    act(() => root.unmount())
  })
})
