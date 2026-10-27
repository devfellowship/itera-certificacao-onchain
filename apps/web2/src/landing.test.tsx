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

  it('v2 copy: every section, honest Hosted LLM Infra, no buyer frame (plan 20261027-testmyagent-web2-copy-repositioning)', () => {
    const c = mountLanding()
    for (const id of ['why', 'how', 'versions', 'cost', 'run', 'next', 'faq', 'start']) {
      expect(c.querySelectorAll(`#${id}`)).toHaveLength(1)
    }
    expect(c.querySelector('h1')?.textContent).toBe("Your agents change. Know if they're getting better.")
    expect(c.querySelector('[data-testid="login-dfl"]')?.textContent).toBe('Sign in')
    expect(c.textContent).toContain('Uses your DevFellowship account')
    const request = c.querySelector<HTMLAnchorElement>('[data-testid="landing-request-access"]')
    expect(request?.textContent).toBe('Request access')
    expect(request?.getAttribute('href')).toMatch(/^mailto:hello@devfellowship\.com/)
    const text = c.textContent ?? ''
    expect(text).toContain('Hosted LLM Infra')
    for (const banned of [/buyer/i, /Platform-run/, /We run it on our infra/, /Copy link/, /Bring your own runner/i, /open source/i, /DFL infra/i, /Start a hosted run/]) {
      expect(text).not.toMatch(banned)
    }
  })

  it('lean design (Tainan TG 24364): the removed blocks stay out, the plan facts stay in', () => {
    const c = mountLanding()
    const text = c.textContent ?? ''
    // Removed or shortened by the design export.
    expect(c.querySelectorAll('.v2-hero-lines p')).toHaveLength(1)
    expect(c.querySelectorAll('.v2-chip')).toHaveLength(2)
    for (const gone of [/keeps the grades/, /new runtime/, /Read the CLI guide/, /how well they did/, /through our MCP tools/]) {
      expect(text).not.toMatch(gone)
    }
    expect(c.querySelector('#run .lv3-rank__list')?.children).toHaveLength(3)
    // Facts where the design and the plan disagree: the plan wins.
    expect(text).not.toMatch(/Or let us run them|\[X\]|vs Opus|Claude Opus/)
    expect(text).toContain('12 / 13 checks')
  })

  it('logged in: shows the email in nav-user-email', () => {
    saveSession({ token: 'tok', user: { id: 'u1', email: 'ana@example.com' } })
    const c = mountLanding()
    expect(c.querySelector('[data-testid="nav-user-email"]')?.textContent).toBe('ana@example.com')
    expect(c.querySelector('[data-testid="login-dfl"]')).toBeNull()
  })
})
