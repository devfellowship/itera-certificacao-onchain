// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(container.textContent).toContain('Test your AI agent. Free. Bring your own OpenRouter key.')
    const buttons = container.querySelectorAll('[data-testid="login-dfl"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toBe('Login with DFL')
  })

  it('renders the login button on /login', () => {
    const container = mountApp('/login')
    expect(container.querySelector('[data-testid="login-dfl"]')?.textContent).toBe('Login with DFL')
  })

  it('renders the callback placeholder', () => {
    const container = mountApp('/auth/dfl/callback')
    expect(container.textContent).toContain('Signing you in')
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
