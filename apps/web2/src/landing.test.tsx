// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { saveSession } from './auth/sessionStorage'
import { routes } from './routes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  window.localStorage.clear()
})

function mountLanding() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/'] })} />))
  return container
}

describe('landing page (web2)', () => {
  it('logged out: exactly one login-dfl and no web3 copy', () => {
    const c = mountLanding()
    expect(c.querySelector('[data-testid="landing-page"]')).not.toBeNull()
    expect(c.querySelectorAll('[data-testid="login-dfl"]')).toHaveLength(1)
    expect(c.querySelectorAll('[data-testid="login-dfl-secondary"]').length).toBeGreaterThan(0)
    const text = c.textContent ?? ''
    expect(text).not.toMatch(/\bSOL\b|Solana|onchain|wallet/i)
    expect(c.querySelector('[data-testid="nav-user-email"]')).toBeNull()
  })

  it('logged in: shows the email in nav-user-email', () => {
    saveSession({ token: 'tok', user: { id: 'u1', email: 'ana@example.com' } })
    const c = mountLanding()
    expect(c.querySelector('[data-testid="nav-user-email"]')?.textContent).toBe('ana@example.com')
    expect(c.querySelector('[data-testid="login-dfl"]')).toBeNull()
  })
})
