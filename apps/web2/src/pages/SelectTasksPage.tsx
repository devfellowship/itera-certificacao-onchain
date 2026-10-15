/**
 * Screen 03 — Select tasks + start (copy of apps/web SelectTasksPage; plan 20261015-testmyagent-web2-client, UI5).
 *
 * Left: the shared Task Filter (inline, run mode). Only runnable tasks are selectable.
 * Right: the "Evaluation" summary. A web2 evaluation is free: the user's own OpenRouter key pays the
 * model tokens (BYOK, ADR-5). "Start evaluation" sends POST /evaluations {agentId, taskIds, modelApiKey}
 * and goes to /evaluations/:eid. The key lives in component state only: it is never logged, stored or
 * put in a URL.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import type { Agent, Model, Task } from '../lib/api'
import { apiErrorMessage, type ApiErrorBody } from '../lib/errors'
import { ModelKeyField } from '../models/ModelKeyField'
import { TaskFilter, findTask, useTaskCatalog } from '../tma/task-filter'
import { Breadcrumb, ModelLabel, Stepper } from '../tma/ui'
import './select-tasks/select-tasks.css'

const STEPS = ['Agent', 'Tasks', 'Evaluation', 'Results']
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function commitOf(agent: Agent | null): string | null {
  if (!agent) return null
  const latest = (agent as { latestVersion?: { commitSha?: string } | null }).latestVersion
  return agent.pinnedCommit ?? latest?.commitSha ?? null
}

/**
 * The shared Task Filter (tma/**) marks its rows `task-filter-row`. The web2 specs select a task by
 * `task-option`, so this hook re-marks the selectable rows. tma/** stays untouched in this lane.
 */
function useTaskOptionMarks(ref: { current: HTMLElement | null }) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const mark = () => {
      el.querySelectorAll<HTMLElement>('[data-testid="task-filter-row"]').forEach((row) => {
        if (row.getAttribute('aria-disabled') !== 'true') row.setAttribute('data-testid', 'task-option')
      })
      el.querySelectorAll<HTMLElement>('[data-testid="task-option"][aria-disabled="true"]').forEach((row) => row.setAttribute('data-testid', 'task-filter-row'))
    }
    mark()
    const obs = new MutationObserver(mark)
    obs.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-disabled'] })
    return () => obs.disconnect()
  }, [ref])
}

function startErrorMessage(e: unknown): string {
  if (e instanceof ApiError) return apiErrorMessage(e.status, (e.body ?? { error: e.message }) as ApiErrorBody)
  return apiErrorMessage(0, null)
}

export function SelectTasksPage() {
  const { aid = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const modelSelectId = useId()
  const catalogState = useTaskCatalog()
  const filterRef = useRef<HTMLDivElement | null>(null)
  useTaskOptionMarks(filterRef)
  const catalog = catalogState.status === 'ready' ? catalogState.catalog : null

  const [agent, setAgent] = useState<Agent | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [models, setModels] = useState<Model[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [model, setModel] = useState('')
  // The OpenRouter key lives in component state only. `checkedKey` is the key the probe accepted.
  const [modelKey, setModelKey] = useState('')
  const [checkedKey, setCheckedKey] = useState<string | null>(null)
  const keyRef = useRef('')
  keyRef.current = modelKey
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  // Agent + model list.
  useEffect(() => {
    let live = true
    api
      .agent(aid)
      .then((r) => live && setAgent(r.agent))
      .catch((e: unknown) => live && setAgentError(e instanceof ApiError && e.status === 404 ? 'Agent not found.' : e instanceof Error ? e.message : String(e)))
    api
      .models()
      .then((r) => {
        if (!live) return
        setModels(r.models)
        setDefaultModel(r.default ?? r.models[0]?.id ?? null)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [aid])

  // The model shown: the agent's own model once known, else the catalog default (as in NewEvaluationPage).
  const modelLocked = Boolean(agent?.model)
  const shownModel = agent?.model ?? (model || defaultModel || '')

  // Selection: ?tasks= ids or slugs. Default = the first runnable task (the design preselects one).
  const urlTasks = params.get('tasks')
  const selected = useMemo<Task[]>(() => {
    if (!catalog) return []
    if (urlTasks === null) {
      const first = catalog.tasks.find((t) => t.runnable && !t.mine) ?? catalog.tasks.find((t) => t.runnable)
      return first ? [first] : []
    }
    return urlTasks
      .split(',')
      .filter(Boolean)
      .map((s) => findTask(catalog.tasks, s))
      .filter((t): t is Task => Boolean(t && t.runnable))
  }, [catalog, urlTasks])
  const selectedIds = selected.map((t) => t.id)

  const onChange = useCallback(
    (ids: string[], tasks: Task[]) => {
      if (busy) return
      const next = new URLSearchParams(params)
      next.set('tasks', tasks.length ? tasks.map((t) => t.slug || t.id).join(',') : ids.join(','))
      setParams(next, { replace: true })
      setStartError(null)
    },
    [params, setParams, busy],
  )

  // Summary values.
  const n = selected.length
  const hiddenTests = selected.reduce((a, t) => a + (t.hiddenTestsCount ?? 0), 0)
  const estMin = selected.reduce((a, t) => a + (t.estMinutes ?? 0), 0)
  const modelInfo = models.find((m) => m.id === shownModel)
  const modelLabel = modelInfo?.label ?? shownModel ?? '—'
  const commit = commitOf(agent)
  const keyOk = checkedKey !== null && checkedKey === modelKey.trim() && modelKey.trim().length > 0
  const canStart = n > 0 && keyOk && !busy && Boolean(agent)

  const onStart = async () => {
    if (!canStart || !agent) return
    setStartError(null)
    setBusy(true)
    const key = modelKey.trim()
    try {
      const release = agent.modelRelease
      const created = await api.createEvaluation({ agentId: agent.id, taskIds: selectedIds, modelApiKey: key, ...(release ? { modelRelease: release } : {}) })
      // Drop the key from memory before the page changes.
      setModelKey('')
      setCheckedKey(null)
      navigate(`/evaluations/${encodeURIComponent(created.evaluationId)}`)
    } catch (e) {
      setBusy(false)
      setStartError(startErrorMessage(e))
    }
  }

  const agentName = agent?.name ?? (agentError ? 'Agent' : '…')
  return (
    <main className="tma-page tma-page--flow st-page" data-testid="select-tasks-page">
      <div className="st-head">
        <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: agentName, to: `/agents/${aid}` }, { label: 'New evaluation' }]} />
        <div className="st-head__row">
          <div className="st-head__titles">
            <h1 className="tma-h1">Select tasks</h1>
            <span className="st-head__sub">Each task is graded by hidden tests outside your agent's sandbox.</span>
          </div>
          <Stepper steps={STEPS} current={1} />
        </div>
      </div>

      <div className="st-grid">
        <div ref={filterRef} className="st-filter">
          <TaskFilter variant="inline" mode="run" selected={selectedIds} onChange={onChange} />
        </div>

        <aside className="st-summary" data-testid="evaluation-summary">
          <div className="st-summary__head">
            <span className="st-summary__title">Evaluation</span>
            <span className="st-mono st-muted" data-testid="summary-count">
              {plural(n, 'task')}
            </span>
          </div>
          <div className="st-kv">
            <span className="st-k">Agent</span>
            <span className="st-v" data-testid="summary-agent">
              {agentError ? <span className="st-danger">{agentError}</span> : agentName} {commit && <span className="st-mono st-muted">{commit.slice(0, 7)}</span>}
            </span>
            <label className="st-k" htmlFor={modelSelectId}>
              Model
            </label>
            <span className="st-v">
              <select
                id={modelSelectId}
                className="w2-input st-select"
                data-testid="model-select"
                value={shownModel}
                disabled={modelLocked || busy}
                onChange={(e) => setModel(e.target.value)}
              >
                {shownModel && !models.some((m) => m.id === shownModel) ? <option value={shownModel}>{shownModel}</option> : null}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label ? `${m.label} (${m.id})` : m.id}
                  </option>
                ))}
              </select>
              {modelInfo && (
                <span className="st-model-label">
                  <ModelLabel model={modelInfo.id} provider={modelInfo.provider} label={modelLabel} size={20} />
                </span>
              )}
            </span>
            <span className="st-k">Hidden tests</span>
            <span className="st-v st-mono">{n ? hiddenTests : '—'}</span>
            <span className="st-k">Est. time</span>
            <span className="st-v st-mono" data-testid="summary-minutes">
              {n ? `~${estMin} min` : '—'}
            </span>
          </div>
          <div className="st-key">
            <ModelKeyField
              value={modelKey}
              onChange={(k) => {
                setModelKey(k)
                setCheckedKey(null)
                setStartError(null)
              }}
              onChecked={() => setCheckedKey(keyRef.current.trim())}
            />
          </div>
          <div className="st-actions">
            <button type="button" className="st-pay" data-testid="start-evaluation" disabled={!canStart} onClick={() => void onStart()}>
              {busy ? 'Starting…' : 'Start evaluation'}
            </button>
            {startError && (
              <span className="st-error" role="alert" data-testid="evaluation-error">
                {startError}
              </span>
            )}
            <span className="st-foot">Free. Your OpenRouter key pays the model; it is sent once and never stored.</span>
          </div>
        </aside>
      </div>
      {agentError && (
        <p className="st-foot">
          <Link to="/agents">Back to agents</Link>
        </p>
      )}
    </main>
  )
}
