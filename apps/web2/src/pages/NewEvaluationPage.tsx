/**
 * New evaluation (plan 20261015-testmyagent-web2-client, T9): pick an agent, one or more curated
 * tasks and a model, enter the OpenRouter key, start. No quote, no payment (free_byok, ADR-5/ADR-6).
 *
 * The OpenRouter key lives in component state only. It is sent once, in the `POST /evaluations`
 * body. It is never logged, never stored, and never shown.
 */
import { useEffect, useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../auth/session'
import { api, type Agent, type Model, type Task } from '../lib/api'
import { apiErrorMessage } from '../lib/errors'
import { ModelKeyField } from '../models/ModelKeyField'
import { RequireLogin } from './RequireLogin'

/** An agent choice: a TestMyAgent sample repo (registered on start) or one of the user's own agents. */
type AgentOption = { key: string; kind: 'sample'; repoFullName: string } | { key: string; kind: 'own'; agent: Agent }

interface Loaded {
  options: AgentOption[]
  tasks: Task[]
  models: Model[]
  defaultModel: string | null
}

export function NewEvaluationPage() {
  return (
    <RequireLogin what="start an evaluation">
      <NewEvaluationForm />
    </RequireLogin>
  )
}

function NewEvaluationForm() {
  const { apiFetch } = useSession()
  const navigate = useNavigate()
  const modelSelectId = useId()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [agentKey, setAgentKey] = useState<string | null>(null)
  const [taskIds, setTaskIds] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [modelKey, setModelKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [samples, agents, tasks, models] = await Promise.all([
        api.sampleRepos(apiFetch),
        api.myAgents(apiFetch),
        api.curatedTasks(apiFetch),
        api.models(apiFetch),
      ])
      if (!alive) return
      const failed = [samples, agents, tasks, models].find((r) => !r.ok)
      if (failed && !failed.ok) {
        setLoadError(apiErrorMessage(failed.status, failed.body))
        return
      }
      if (!samples.ok || !agents.ok || !tasks.ok || !models.ok) return
      const options: AgentOption[] = [
        ...samples.body.agents.map((repoFullName) => ({ key: `sample:${repoFullName}`, kind: 'sample' as const, repoFullName })),
        ...agents.body.agents.filter((a) => a.source !== 'sample').map((agent) => ({ key: `own:${agent.id}`, kind: 'own' as const, agent })),
      ]
      setLoaded({ options, tasks: tasks.body.tasks.filter((t) => t.runnable), models: models.body.models, defaultModel: models.body.default })
      setModel(models.body.default ?? models.body.models[0]?.id ?? '')
    })()
    return () => {
      alive = false
    }
  }, [apiFetch])

  if (loadError) {
    return (
      <main className="w2-shell">
        <h1>New evaluation</h1>
        <p className="w2-error" role="alert" data-testid="evaluation-error">
          {loadError}
        </p>
      </main>
    )
  }
  if (!loaded) {
    return (
      <main className="w2-shell">
        <h1>New evaluation</h1>
        <p className="w2-lead">Loading…</p>
      </main>
    )
  }

  const selected = loaded.options.find((o) => o.key === agentKey) ?? null
  const modelLocked = selected?.kind === 'own'
  const shownModel = selected?.kind === 'own' ? selected.agent.model : model
  const canStart = Boolean(selected) && taskIds.length > 0 && modelKey.trim().length > 0 && Boolean(shownModel) && !submitting

  const toggleTask = (id: string) => setTaskIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  async function start() {
    if (!selected) return
    setSubmitting(true)
    setSubmitError(null)
    let agentId: string
    if (selected.kind === 'sample') {
      const reg = await api.registerSampleAgent(apiFetch, selected.repoFullName, model)
      if (!reg.ok) {
        setSubmitError(apiErrorMessage(reg.status, reg.body))
        setSubmitting(false)
        return
      }
      agentId = reg.body.agent.id
    } else {
      agentId = selected.agent.id
    }
    const res = await api.startEvaluation(apiFetch, { agentId, taskIds, modelApiKey: modelKey.trim() })
    if (!res.ok) {
      setSubmitError(apiErrorMessage(res.status, res.body))
      setSubmitting(false)
      return
    }
    // Drop the key from memory before the page changes.
    setModelKey('')
    navigate(`/evaluations/${encodeURIComponent(res.body.evaluationId)}`)
  }

  return (
    <main className="w2-shell w2-wide">
      <h1>New evaluation</h1>
      <p className="w2-lead">Free. Your agent runs on your own OpenRouter key. The result is a graded score.</p>

      <section className="w2-section" aria-labelledby="w2-agent-h">
        <h2 id="w2-agent-h">1. Agent</h2>
        {loaded.options.length === 0 ? (
          <p className="w2-muted">No agent is available.</p>
        ) : (
          <ul className="w2-options" role="radiogroup" aria-label="Agent">
            {loaded.options.map((o) => (
              <li key={o.key}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={agentKey === o.key}
                  className={`w2-option${agentKey === o.key ? ' is-selected' : ''}`}
                  data-testid="agent-option"
                  data-kind={o.kind}
                  onClick={() => setAgentKey(o.key)}
                >
                  <span className="w2-option-title">{o.kind === 'sample' ? o.repoFullName : o.agent.name}</span>
                  <span className="w2-option-meta">{o.kind === 'sample' ? 'Sample agent · no GitHub install needed' : `${o.agent.repoFullName} · ${o.agent.model}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="w2-section" aria-labelledby="w2-model-h">
        <h2 id="w2-model-h">2. Model</h2>
        <label htmlFor={modelSelectId} className="w2-keyfield-label">
          Model
        </label>
        <select
          id={modelSelectId}
          className="w2-input"
          data-testid="model-select"
          value={shownModel}
          disabled={modelLocked}
          onChange={(e) => setModel(e.target.value)}
        >
          {modelLocked && !loaded.models.some((m) => m.id === shownModel) ? <option value={shownModel}>{shownModel}</option> : null}
          {loaded.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label ? `${m.label} (${m.id})` : m.id}
            </option>
          ))}
        </select>
        {modelLocked ? <p className="w2-muted">Your own agent runs on the model it was registered with.</p> : null}
      </section>

      <section className="w2-section" aria-labelledby="w2-tasks-h">
        <h2 id="w2-tasks-h">3. Tasks</h2>
        {loaded.tasks.length === 0 ? (
          <p className="w2-muted">No runnable task is available now.</p>
        ) : (
          <ul className="w2-options">
            {loaded.tasks.map((t) => (
              <li key={t.id}>
                <label className={`w2-option${taskIds.includes(t.id) ? ' is-selected' : ''}`}>
                  <input type="checkbox" data-testid="task-option" data-task-id={t.id} checked={taskIds.includes(t.id)} onChange={() => toggleTask(t.id)} />
                  <span className="w2-option-title">{t.name}</span>
                  {t.description ? <span className="w2-option-meta">{t.description}</span> : null}
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="w2-section" aria-labelledby="w2-key-h">
        <h2 id="w2-key-h">4. OpenRouter key</h2>
        <ModelKeyField value={modelKey} onChange={setModelKey} />
      </section>

      {submitError ? (
        <p className="w2-error" role="alert" data-testid="evaluation-error">
          {submitError}
        </p>
      ) : null}
      <button type="button" className="w2-btn" data-testid="start-evaluation" disabled={!canStart} onClick={() => void start()}>
        {submitting ? 'Starting…' : `Start evaluation${taskIds.length > 1 ? ` (${taskIds.length} runs)` : ''}`}
      </button>
    </main>
  )
}
