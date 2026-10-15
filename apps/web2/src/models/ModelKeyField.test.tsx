// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider } from '../auth/session'
import { saveSession } from '../auth/sessionStorage'
import { DEFAULT_API_URL } from '../config'
import { ModelKeyField, OPENROUTER_KEYS_URL } from './ModelKeyField'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'sk-or-v1-WEB2SECRETKEYPART0000000000'
const SESSION = { token: 'tma-session-token', user: { id: 'dfl:1', email: 'ana@example.com' } }

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

function Harness() {
  const [key, setKey] = useState('')
  return <ModelKeyField value={key} onChange={setKey} />
}

function mount() {
  saveSession(SESSION)
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(<SessionProvider redirect={() => {}}><Harness /></SessionProvider>))
  return c
}

function type(c: HTMLElement, value: string) {
  const input = c.querySelector<HTMLInputElement>('[data-testid="model-key-input"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function clickCheck(c: HTMLElement) {
  act(() => c.querySelector<HTMLButtonElement>('[data-testid="model-key-check"]')!.click())
  await flush()
}

describe('ModelKeyField', () => {
  it('is a password input and explains why BYOK, with a link to OpenRouter keys', () => {
    const c = mount()
    expect(c.querySelector<HTMLInputElement>('[data-testid="model-key-input"]')!.type).toBe('password')
    const why = c.querySelector('[data-testid="model-key-why"]')!
    expect(why.textContent).toContain('your own OpenRouter key')
    expect(why.querySelector('a')!.getAttribute('href')).toBe(OPENROUTER_KEYS_URL)
  })

  it('"Check key" posts the key to /models/access with the session and shows the label and the credit', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const fetchMock = vi.fn(async () => json(200, { label: 'sk-or-v1-abc...xyz', limitRemaining: 4.5, isFreeTier: false }))
    vi.stubGlobal('fetch', fetchMock)
    const c = mount()
    type(c, KEY)
    await clickCheck(c)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${DEFAULT_API_URL}/models/access`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ openrouterKey: KEY })
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${SESSION.token}`)
    expect(c.querySelector('[data-testid="model-key-ok"]')!.textContent).toBe('Key OK: sk-or-v1-abc...xyz. Credit left: US$4.50.')
    // The key is never shown, stored, or logged.
    expect(c.textContent).not.toContain('WEB2SECRET')
    expect(JSON.stringify({ ...localStorage })).not.toContain('WEB2SECRET')
    expect(JSON.stringify(logs.flatMap((s) => s.mock.calls))).not.toContain('WEB2SECRET')
  })

  it.each([
    [422, { code: 'model_key_invalid' }, 'does not accept this key'],
    [422, { code: 'model_key_no_credit' }, 'no credit left'],
    [503, { code: 'model_key_probe_unavailable' }, 'cannot reach OpenRouter'],
  ])('shows the %i %o error', async (status, body, text) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(status, body)))
    const c = mount()
    type(c, KEY)
    await clickCheck(c)
    expect(c.querySelector('[data-testid="model-key-error"]')!.textContent).toContain(text)
    expect(c.querySelector('[data-testid="model-key-ok"]')).toBeNull()
  })

  it('an empty key does not call the API', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const c = mount()
    await clickCheck(c)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(c.querySelector('[data-testid="model-key-error"]')!.textContent).toContain('Enter your OpenRouter API key')
  })
})
