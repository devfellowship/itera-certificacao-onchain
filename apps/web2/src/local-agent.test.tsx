// @vitest-environment jsdom
// "New local agent" on /agents/new (plan 20261026-tma-local-runner-and-self-declared-results, L11; API task L4).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider } from './auth/session'
import { saveSession } from './auth/sessionStorage'
import { AddAgentPage } from './pages/AddAgentPage'
import { localAgentErrorMessage, modelsFor, SCHEMA_NOT_READY_MESSAGE } from './pages/add-agent/LocalAgentForm'
import { ApiError } from './lib/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = { token: 'tma-session-token', user: { id: 'dfl:1', email: 'ana@example.com' } }
const NEW_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const OPTIONS = {
  providers: [
    { key: 'anthropic', name: 'Anthropic' },
    { key: 'openai', name: 'OpenAI' },
    { key: 'google', name: 'Google' },
    { key: 'qwen', name: 'Alibaba Qwen' },
    { key: 'deepseek', name: 'DeepSeek' },
    { key: 'zai', name: 'Zhipu' },
  ],
  routes: [
    { key: 'openrouter', name: 'OpenRouter' },
    { key: 'opencode-go', name: 'opencode go' },
    { key: 'ollama', name: 'local Ollama' },
    { key: 'zai', name: 'Z.ai API' },
    { key: 'codex', name: 'Codex CLI' },
    { key: 'claude-code', name: 'Claude Code CLI' },
    { key: 'minimax', name: 'MiniMax API' },
  ],
  models: [
    { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', provider: 'anthropic', route: 'openrouter', known: true },
    { id: 'openai/gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', route: 'openrouter', known: true },
    { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', provider: 'deepseek', route: 'openrouter', known: true },
  ],
  custom: [{ id: 'ollama/gemma4:12b', label: 'Gemma 4 12B', provider: 'google', providerLabel: null, route: 'ollama', known: false }],
}

let root: Root | undefined
beforeEach(() => {
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function waitFor(check: () => boolean, label: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

const probe = { pathname: '', search: '' }
function LocationProbe() {
  const loc = useLocation()
  probe.pathname = loc.pathname
  probe.search = loc.search
  return null
}

type Handler = (url: URL, init: RequestInit) => Response
function mountAt(path: string, handler: Handler = () => json(404, { error: 'no mock' }), modelOptions: () => Response = () => json(200, OPTIONS)) {
  saveSession(SESSION)
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/me') return json(200, { wallet: 'dfl:1', username: 'ana', displayName: 'Ana', handle: null, avatarUrl: null, initials: 'AN' })
    if (url.pathname === '/model-options') return modelOptions()
    // The GitHub flow's own reads (installations, repos, models, sample repos): empty answers.
    if (url.pathname === '/models') return json(200, { default: 'openai/gpt-5-mini', models: [{ id: 'openai/gpt-5-mini', label: 'GPT-5 mini', enabled: true, releases: [] }] })
    if (url.pathname === '/github/installations') return json(200, { installations: [] })
    if (url.pathname === '/github/repos') return json(200, { repos: [] })
    if (url.pathname === '/github/sample-repos') return json(200, { agents: [], tasks: [] })
    return handler(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route element={<SessionProvider><Outlet /></SessionProvider>}>
            <Route path="/agents/new" element={<AddAgentPage />} />
            <Route path="/agents/:aid" element={<div data-testid="agent-page-stub" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  )
  return { c, fetchMock }
}

const q = <T extends Element = HTMLElement>(c: Element, id: string) => c.querySelector<T>(`[data-testid="${id}"]`)
const select = (c: Element, id: string) => q<HTMLSelectElement>(c, id)!
const optionValues = (s: HTMLSelectElement) => Array.from(s.options).map((o) => o.value)

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function choose(s: HTMLSelectElement, value: string) {
  act(() => {
    s.value = value
    s.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click())
const postCalls = (m: ReturnType<typeof vi.fn>) => (m.mock.calls as unknown as Array<[string, RequestInit | undefined]>).filter(([, i]) => i?.method === 'POST').map(([u, i]) => ({ path: new URL(u).pathname, body: JSON.parse(String(i?.body)) as Record<string, unknown> }))

async function openLocalForm(handler?: Handler) {
  const m = mountAt('/agents/new?source=local', handler)
  await waitFor(() => q(m.c, 'local-provider-select') !== null, 'options loaded')
  return m
}
const post = (status: number, body: unknown): Handler => (url, init) => (url.pathname === '/agents/local' && init.method === 'POST' ? json(status, body) : json(404, { error: 'no mock' }))

describe('/agents/new source choice', () => {
  it('defaults to the GitHub flow: the GitHub model card is there and the local form is not', async () => {
    const { c } = mountAt('/agents/new')
    await waitFor(() => q(c, 'model-card') !== null, 'github flow')
    expect(q(c, 'local-agent-form')).toBeNull()
    expect(q(c, 'source-github')?.querySelector('[role="radio"]')?.getAttribute('aria-checked')).toBe('true')
    expect(q(c, 'continue-to-tasks')).not.toBeNull()
  })

  it('switches to the local form on click (URL ?source=local) and back', async () => {
    const { c } = mountAt('/agents/new')
    await waitFor(() => q(c, 'model-card') !== null, 'github flow')
    click(q(c, 'source-local')?.querySelector('[role="radio"]'))
    await waitFor(() => q(c, 'local-agent-form') !== null, 'local form')
    expect(probe.search).toBe('?source=local')
    expect(q(c, 'model-card')).toBeNull()
    click(q(c, 'source-github')?.querySelector('[role="radio"]'))
    await waitFor(() => q(c, 'model-card') !== null, 'github flow again')
    expect(probe.search).toBe('')
    expect(q(c, 'local-agent-form')).toBeNull()
  })
})

describe('New local agent form', () => {
  it('fills the three selects from /model-options; a provider filters the models; the route follows the model', async () => {
    const { c } = await openLocalForm()
    const provider = select(c, 'local-provider-select')
    const model = select(c, 'local-model-select')
    const route = select(c, 'local-route-select')
    expect(optionValues(provider)).toEqual(['', 'anthropic', 'openai', 'google', 'qwen', 'deepseek', 'zai'])
    expect(optionValues(model)).toEqual(['', 'anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'deepseek/deepseek-v4.1-flash', 'ollama/gemma4:12b'])
    expect(optionValues(route)).toEqual(['openrouter', 'opencode-go', 'ollama', 'zai', 'codex', 'claude-code', 'minimax'])
    expect(route.value).toBe('openrouter')

    choose(provider, 'google')
    expect(optionValues(select(c, 'local-model-select'))).toEqual(['', 'ollama/gemma4:12b'])
    expect(c.querySelector('[data-testid="local-provider-preview"] [data-lab="google"]')).not.toBeNull()

    choose(select(c, 'local-model-select'), 'ollama/gemma4:12b')
    expect(select(c, 'local-route-select').value).toBe('ollama')

    // Another provider: the model of the old provider leaves the select and the field clears.
    choose(select(c, 'local-provider-select'), 'deepseek')
    expect(select(c, 'local-model-select').value).toBe('')
    expect(optionValues(select(c, 'local-model-select'))).toEqual(['', 'deepseek/deepseek-v4.1-flash'])
    choose(select(c, 'local-model-select'), 'deepseek/deepseek-v4.1-flash')
    expect(select(c, 'local-route-select').value).toBe('openrouter')
  })

  it('a model chosen with no provider sets the provider from the model', async () => {
    const { c } = await openLocalForm()
    choose(select(c, 'local-model-select'), 'openai/gpt-5-mini')
    expect(select(c, 'local-provider-select').value).toBe('openai')
    expect(c.querySelector('[data-testid="local-provider-preview"] [data-lab="openai"]')).not.toBeNull()
  })

  it('submits the right body to POST /agents/local and goes to /agents/<id>', async () => {
    const { c, fetchMock } = await openLocalForm(post(201, { agent: { id: NEW_ID, name: 'Laptop agent', connector: 'local' } }))
    expect(q<HTMLButtonElement>(c, 'create-local-agent')!.disabled).toBe(true)
    type(q<HTMLInputElement>(c, 'local-name-input')!, '  Laptop agent ')
    type(q<HTMLInputElement>(c, 'local-description-input')!, 'Runs on my laptop.')
    type(q<HTMLInputElement>(c, 'local-harness-input')!, 'opencode 1.18.31')
    choose(select(c, 'local-provider-select'), 'deepseek')
    choose(select(c, 'local-model-select'), 'deepseek/deepseek-v4.1-flash')
    choose(select(c, 'local-route-select'), 'opencode-go')
    click(c.querySelector('[role="radiogroup"][aria-label="Visibility"] [role="radio"]:nth-child(2)'))
    expect(q<HTMLButtonElement>(c, 'create-local-agent')!.disabled).toBe(false)
    click(q(c, 'create-local-agent'))
    await waitFor(() => probe.pathname === `/agents/${NEW_ID}`, 'navigation to the agent page')
    const posts = postCalls(fetchMock)
    expect(posts).toHaveLength(1)
    expect(posts[0].path).toBe('/agents/local')
    expect(posts[0].body).toEqual({
      name: 'Laptop agent',
      model_id: 'deepseek/deepseek-v4.1-flash',
      route_key: 'opencode-go',
      provider_key: 'deepseek',
      description: 'Runs on my laptop.',
      harness: 'opencode 1.18.31',
      visibility: 'listed',
    })
  })

  it('503 schema_not_ready shows the message and keeps the input', async () => {
    const { c } = await openLocalForm(post(503, { error: 'schema_not_ready', message: 'migration 0021 pending' }))
    type(q<HTMLInputElement>(c, 'local-name-input')!, 'Laptop agent')
    choose(select(c, 'local-model-select'), 'openai/gpt-5-mini')
    click(q(c, 'create-local-agent'))
    await waitFor(() => q(c, 'local-save-error') !== null, 'error shown')
    expect(q(c, 'local-save-error')!.textContent).toBe(SCHEMA_NOT_READY_MESSAGE)
    expect(q(c, 'local-save-error')!.textContent).toBe('Local agents are not available yet. Try again later.')
    expect(q<HTMLInputElement>(c, 'local-name-input')!.value).toBe('Laptop agent')
    expect(select(c, 'local-model-select').value).toBe('openai/gpt-5-mini')
    expect(q<HTMLButtonElement>(c, 'create-local-agent')!.disabled).toBe(false)
    expect(probe.pathname).toBe('/agents/new')
  })

  it('409 agent_name_taken shows its message', async () => {
    const { c } = await openLocalForm(post(409, { error: 'agent_name_taken', message: 'taken' }))
    type(q<HTMLInputElement>(c, 'local-name-input')!, 'Laptop agent')
    choose(select(c, 'local-model-select'), 'openai/gpt-5-mini')
    click(q(c, 'create-local-agent'))
    await waitFor(() => q(c, 'local-save-error') !== null, 'error shown')
    expect(q(c, 'local-save-error')!.textContent).toBe('You already have an agent with this name.')
  })

  it('shows a loading state, then an error state with Retry when /model-options fails', async () => {
    let fail = true
    const { c } = mountAt('/agents/new?source=local', undefined, () => (fail ? json(500, { error: 'boom' }) : json(200, OPTIONS)))
    expect(q(c, 'local-options-loading')).not.toBeNull()
    expect(q<HTMLButtonElement>(c, 'create-local-agent')!.disabled).toBe(true)
    await waitFor(() => q(c, 'local-options-error') !== null, 'error state')
    expect(q(c, 'local-options-loading')).toBeNull()
    expect(q(c, 'local-options-retry')).not.toBeNull()
    expect(q<HTMLButtonElement>(c, 'create-local-agent')!.disabled).toBe(true)
    fail = false
    click(q(c, 'local-options-retry'))
    await waitFor(() => q(c, 'local-provider-select') !== null, 'options after retry')
    expect(q(c, 'local-options-error')).toBeNull()
  })
})

describe('helpers', () => {
  it('modelsFor merges known and custom models and filters by provider', () => {
    expect(modelsFor(null, '')).toEqual([])
    expect(modelsFor(OPTIONS, '').map((m) => m.id)).toHaveLength(4)
    expect(modelsFor(OPTIONS, 'google').map((m) => m.id)).toEqual(['ollama/gemma4:12b'])
    expect(modelsFor(OPTIONS, 'nobody')).toEqual([])
  })

  it('localAgentErrorMessage maps every API code to a readable sentence', () => {
    const err = (status: number, error: string, message?: string) => new ApiError(status, error, { error, message })
    expect(localAgentErrorMessage(err(503, 'schema_not_ready'))).toBe(SCHEMA_NOT_READY_MESSAGE)
    expect(localAgentErrorMessage(err(409, 'agent_name_taken'))).toBe('You already have an agent with this name.')
    expect(localAgentErrorMessage(err(400, 'unknown_model'))).toMatch(/model is not in the list/)
    expect(localAgentErrorMessage(err(400, 'unknown_provider'))).toMatch(/provider is not in the list/)
    expect(localAgentErrorMessage(err(400, 'unknown_route'))).toMatch(/route is not in the list/)
    expect(localAgentErrorMessage(err(400, 'invalid', 'name is too long'))).toBe('Check the form: name is too long')
    expect(localAgentErrorMessage(new TypeError('fetch failed'))).toMatch(/Could not reach the server/)
  })
})
