/**
 * "New local agent" (plan 20261026-tma-local-runner-and-self-declared-results, L11; API task L4).
 * GET /model-options fills Provider, Model and Route. POST /agents/local creates the agent; on 201 the page
 * goes to /agents/<id>, where the tma CLI steps are shown. Before migration 0021 the API answers
 * 503 schema_not_ready: the form shows a clear message and keeps the input.
 * The three selects are native <select> elements (full width on a 375 px screen, readable by an e2e option count).
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import type { AgentVisibility, CreateLocalAgentInput, ModelOption, ModelOptionsResponse } from '../../lib/api'
import { Breadcrumb, Button, Card, Field, Input, ModelAvatar, PROVIDER_NAME, RadioCard } from '../../tma/ui'
import { describeError } from './errors'
import { useLoad } from './useLoad'
import './local-agent-form.css'

export const LOCAL_AGENT_NAME_MAX = 120
export const LOCAL_AGENT_DESCRIPTION_MAX = 90
export const LOCAL_AGENT_HARNESS_MAX = 120
export const SCHEMA_NOT_READY_MESSAGE = 'Local agents are not available yet. Try again later.'

/** The user message for a refused POST /agents/local. The API code picks the text; `invalid` shows the API's reason. */
export function localAgentErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = (e.body ?? {}) as { error?: string; message?: string }
    switch (body.error ?? e.message) {
      case 'schema_not_ready':
        return SCHEMA_NOT_READY_MESSAGE
      case 'agent_name_taken':
        return 'You already have an agent with this name.'
      case 'unknown_model':
        return 'This model is not in the list. Choose a model from the list.'
      case 'unknown_provider':
        return 'This provider is not in the list. Choose a provider from the list.'
      case 'unknown_route':
        return 'This route is not in the list. Choose a route from the list.'
      case 'invalid':
        return body.message ? `Check the form: ${body.message}` : 'Check the form and try again.'
    }
    if (e.status === 503) return SCHEMA_NOT_READY_MESSAGE
  }
  return describeError(e, 'Could not save the agent. Try again.')
}

/** The models the Model select offers: known + the caller's custom ones, limited to a provider when one is chosen. */
export function modelsFor(options: ModelOptionsResponse | null, providerKey: string): ModelOption[] {
  if (!options) return []
  const all = [...options.models, ...options.custom]
  return providerKey ? all.filter((m) => m.provider === providerKey) : all
}

export function LocalAgentForm() {
  const navigate = useNavigate()
  const options = useLoad(() => api.modelOptions(), [])
  const data = options.data

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [providerKey, setProviderKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [routeKey, setRouteKey] = useState('')
  const [harness, setHarness] = useState('')
  const [visibility, setVisibility] = useState<AgentVisibility>('private')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const models = useMemo(() => modelsFor(data, providerKey), [data, providerKey])
  const model = models.find((m) => m.id === modelId) ?? null
  const routes = data?.routes ?? []

  // The route follows the model; the first route is the default until a model is chosen.
  useEffect(() => {
    if (!data) return
    if (model && routes.some((r) => r.key === model.route)) setRouteKey(model.route)
    else if (!routeKey && routes[0]) setRouteKey(routes[0].key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, model?.id])

  const onProvider = (key: string) => {
    setProviderKey(key)
    // A model of another provider leaves the list: clear it so the form never sends a pair the API refuses.
    if (modelId && !modelsFor(data, key).some((m) => m.id === modelId)) setModelId('')
  }
  const onModel = (id: string) => {
    setModelId(id)
    // No provider yet: take the model's own, so the logo preview and `provider_key` follow the model.
    const m = modelsFor(data, '').find((x) => x.id === id)
    if (!providerKey && m?.provider) setProviderKey(m.provider)
  }

  const previewProvider = providerKey || model?.provider || null
  const canSubmit = name.trim().length > 0 && modelId !== '' && routeKey !== '' && !saving

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    const body: CreateLocalAgentInput = {
      name: name.trim(),
      model_id: modelId,
      route_key: routeKey,
      visibility,
      ...(providerKey ? { provider_key: providerKey } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(harness.trim() ? { harness: harness.trim() } : {}),
    }
    try {
      const { agent } = await api.createLocalAgent(body)
      navigate(`/agents/${encodeURIComponent(agent.id)}`)
    } catch (e) {
      setError(localAgentErrorMessage(e))
      setSaving(false)
    }
  }

  const loading = options.status === 'loading' && !data
  const failed = options.status === 'error' && !data

  return (
    <form className="laf" data-testid="local-agent-form" onSubmit={submit} noValidate>
      <Card className="ta-card">
        <span className="tma-label">Identity</span>
        <Field label="Name" htmlFor="laf-name" hint={`${name.length}/${LOCAL_AGENT_NAME_MAX}`}>
          <Input id="laf-name" value={name} maxLength={LOCAL_AGENT_NAME_MAX} required onChange={(e) => setName(e.target.value)} data-testid="local-name-input" placeholder="My local agent" />
        </Field>
        <Field label="One-line description" htmlFor="laf-desc" hint={`${description.length}/${LOCAL_AGENT_DESCRIPTION_MAX}`}>
          <Input id="laf-desc" value={description} onChange={(e) => setDescription(e.target.value.slice(0, LOCAL_AGENT_DESCRIPTION_MAX))} data-testid="local-description-input" />
        </Field>
      </Card>

      <Card className="ta-card" data-testid="local-model-card">
        <div className="ta-card__top">
          <span className="tma-label">Model · declared by you</span>
          <span className="tma-badge tma-badge--neutral">Self-declared</span>
        </div>
        {loading ? (
          <div className="laf-state" aria-busy="true" data-testid="local-options-loading">
            <span className="ta-skel" />
            <span className="ta-skel" />
          </div>
        ) : failed ? (
          <div className="ta-stack" data-testid="local-options-error">
            <span className="ta-error" role="alert">
              {describeError(options.error, 'Could not load the model options. Try again.')}
            </span>
            <div>
              <Button variant="secondary" size={32} onClick={options.reload} data-testid="local-options-retry">
                Retry
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="laf-preview" data-testid="local-provider-preview">
              <ModelAvatar provider={previewProvider} model={modelId || null} size={28} />
              <span className="laf-preview__text">{previewProvider ? PROVIDER_NAME[previewProvider] ?? previewProvider : 'Pick a provider or a model to see its logo'}</span>
            </div>
            <div className="laf-selects">
              <Field label="Provider" htmlFor="laf-provider">
                <select id="laf-provider" className="tma-input laf-select" value={providerKey} onChange={(e) => onProvider(e.target.value)} data-testid="local-provider-select">
                  <option value="">Any provider</option>
                  {(data?.providers ?? []).map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model" htmlFor="laf-model" hint={models.length === 0 ? 'No model for this provider.' : undefined}>
                <select id="laf-model" className="tma-input laf-select" value={modelId} onChange={(e) => onModel(e.target.value)} data-testid="local-model-select">
                  <option value="">Select a model</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.known ? m.label : `${m.label} · custom`} ({m.id})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Route" htmlFor="laf-route" hint="Where the model runs. It follows the model; change it if your setup differs.">
                <select id="laf-route" className="tma-input laf-select" value={routeKey} onChange={(e) => setRouteKey(e.target.value)} data-testid="local-route-select">
                  {routes.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </>
        )}
        <Field label="Harness (optional)" htmlFor="laf-harness" hint="The program that drives the model on your machine, for example opencode 1.18.31.">
          <Input id="laf-harness" value={harness} maxLength={LOCAL_AGENT_HARNESS_MAX} onChange={(e) => setHarness(e.target.value)} data-testid="local-harness-input" placeholder="opencode 1.18.31" />
        </Field>
      </Card>

      <Card className="ta-card ta-card--tight">
        <span className="tma-label">Visibility</span>
        <div className="laf-visibility" role="radiogroup" aria-label="Visibility">
          <RadioCard checked={visibility === 'private'} onSelect={() => setVisibility('private')} title="Private" description="Only you. Self-declared results are never public." />
          <RadioCard checked={visibility === 'listed'} onSelect={() => setVisibility('listed')} title="Listed" description="The agent name is listed. Its self-declared results stay visible only to you." />
        </div>
      </Card>

      <div className="ta-actions">
        {error && (
          <span className="ta-error" role="alert" data-testid="local-save-error">
            {error}
          </span>
        )}
        <div className="ta-actions__row">
          <Button variant="secondary" onClick={() => navigate('/agents')}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!canSubmit || loading || failed} data-testid="create-local-agent">
            {saving ? 'Creating…' : 'Create local agent'}
          </Button>
        </div>
      </div>
    </form>
  )
}

/** The /agents/new page in local mode: the same head as the GitHub flow, the source picker, and the form. */
export function LocalAgentPage({ picker }: { picker: ReactNode }) {
  return (
    <main className="tma-page tma-page--flow" data-testid="add-agent-page" data-source="local">
      <div className="ta-head">
        <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: 'New local agent' }]} />
        <div className="ta-head__row">
          <h1 className="tma-h1">Add agent</h1>
        </div>
        {picker}
      </div>
      <div className="laf-grid">
        <LocalAgentForm />
        <aside className="ta-col">
          <Card pad className="laf-about">
            <span className="tma-label">How a local agent works</span>
            <ul className="laf-about__list">
              <li>You run the agent on your machine with the tma CLI and your own model key.</li>
              <li>Only numbers leave your machine: the result file holds no code, no patch and no key.</li>
              <li>TestMyAgent does not run or verify the result. It is marked Self-declared and only you can see it.</li>
              <li>A local agent never appears in the ranking.</li>
            </ul>
          </Card>
        </aside>
      </div>
    </main>
  )
}
