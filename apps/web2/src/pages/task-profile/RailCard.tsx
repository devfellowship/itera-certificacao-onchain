/**
 * "Run your agent on this task" (addendum U32 part 3, rail card) and the compatibility check of the
 * signed-in user's agents (U28: GET /tasks/:idOrSlug/compatibility?agentId=).
 */
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/session'
import { api } from '../../lib/api'
import type { Agent, TaskCompatibility, TaskProfile } from '../../lib/api/types'
import { Badge, Button, ButtonLink, Select } from '../../tma/ui'
import { scrollToSection } from './helpers'

type Check = { kind: 'idle' } | { kind: 'checking' } | { kind: 'done'; result: TaskCompatibility } | { kind: 'error' }

function useRunAction(task: TaskProfile) {
  const session = useSession()
  const navigate = useNavigate()
  const [wantRun, setWantRun] = useState(false)
  const target = `/agents?tasks=${encodeURIComponent(task.slug)}`
  useEffect(() => {
    if (wantRun && session.status === 'signed-in') navigate(target)
  }, [wantRun, session.status, navigate, target])
  // web2 signs in by redirect (Login with DFL): the session has no connecting or signing state.
  const busy = false
  return { session, target, busy, start: () => (session.status === 'signed-in' ? navigate(target) : (setWantRun(true), session.signIn())) }
}

export function RunButton({ task, testId }: { task: TaskProfile; testId?: string }) {
  const { session, target, busy, start } = useRunAction(task)
  if (!task.runnable) {
    return (
      <Button variant="primary" block disabled data-testid={testId}>
        Coming soon
      </Button>
    )
  }
  if (session.status === 'signed-in') {
    return (
      <ButtonLink href={target} variant="primary" block data-testid={testId}>
        Evaluate your agent
      </ButtonLink>
    )
  }
  return (
    <Button variant="primary" block onClick={start} disabled={busy} data-testid={testId}>
      Evaluate your agent
    </Button>
  )
}

function CompatibilityCheck({ task }: { task: TaskProfile }) {
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [check, setCheck] = useState<Check>({ kind: 'idle' })
  const [tries, setTries] = useState(0)

  useEffect(() => {
    let live = true
    api
      .agents()
      .then((r) => live && setAgents(r.agents))
      .catch(() => live && setAgents([]))
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!agentId) return
    let live = true
    setCheck({ kind: 'checking' })
    api
      .taskCompatibility(task.slug, agentId)
      .then((result) => live && setCheck({ kind: 'done', result }))
      .catch(() => live && setCheck({ kind: 'error' }))
    return () => {
      live = false
    }
  }, [agentId, task.slug, tries])

  if (!agents || agents.length === 0) return null
  return (
    <div className="tp-compat" data-testid="compat">
      <span className="tma-label">Check an agent</span>
      <Select value={agentId} placeholder="Pick one of your agents" options={agents.map((a) => ({ value: a.id, label: a.name }))} onChange={setAgentId} aria-label="Check an agent" />
      {check.kind === 'checking' && (
        <div className="tp-compat__row" data-testid="compat-checking">
          <Badge tone="neutral">Checking…</Badge>
        </div>
      )}
      {check.kind === 'error' && (
        <div className="tp-compat__row" data-testid="compat-error">
          <Badge tone="neutral">Not checked</Badge>
          <button type="button" className="tp-text-btn" onClick={() => setTries((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {check.kind === 'done' && <CompatResult result={check.result} />}
    </div>
  )
}

function CompatResult({ result }: { result: TaskCompatibility }) {
  const failed = new Set(result.reasons.map((r) => r.requirement))
  return (
    <div className="tp-compat__result" data-testid="compat-result">
      {result.compatible ? (
        <Badge tone="success" dot testId="compat-compatible">
          Compatible
        </Badge>
      ) : (
        <Badge tone="warning" testId="compat-incompatible">
          Incompatible
        </Badge>
      )}
      {result.requires.length === 0 ? (
        <span className="tma-body-sm tma-muted">This agent declares no requirements, so every task fits it.</span>
      ) : (
        <ul className="tp-compat__list">
          {result.requires.map((r) => (
            <li key={r} className={failed.has(r) ? 'tp-compat__no' : 'tp-compat__ok'}>
              <span aria-hidden="true">{failed.has(r) ? '✕' : '✓'}</span>
              <span className="tp-mono12">{r}</span>
            </li>
          ))}
        </ul>
      )}
      {result.reasons.map((r) => (
        <span key={r.requirement} className="tma-body-sm tma-muted">
          {r.message}
        </span>
      ))}
      {!result.compatible && <span className="tma-body-sm tma-muted">Nothing is charged for an incompatible pair.</span>}
    </div>
  )
}

export function RailCard({ task }: { task: TaskProfile }) {
  const session = useSession()
  const [, setSearch] = useSearchParams()
  // L14a: the scoring section lives in the Rubric tab. Open the tab, then scroll to it.
  const howScored = () => {
    setSearch(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('tab', 'rubric')
        return next
      },
      { replace: true },
    )
    window.setTimeout(() => scrollToSection('scoring'), 0)
  }
  return (
    <aside className="tp-rail" data-testid="rail-card">
      <div className="tma-card tp-rail__card">
        <span className="tp-rail__title">Run your agent on this task</span>
        <div className="tp-rail__price">
          <span className="tp-rail__usd" data-testid="price">
            Free
          </span>
          <span className="tma-body-sm tma-muted">Free · your OpenRouter key</span>
        </div>
        <div className="tp-rail__time">
          <span className="tma-label">Estimated time</span>
          <span className="tp-mono13">{task.estMinutes != null ? `~${task.estMinutes} min` : '—'}</span>
        </div>
        <RunButton task={task} testId="cta-run" />
        {session.status === 'signed-in' && <CompatibilityCheck task={task} />}
        <button type="button" className="tp-text-btn tp-rail__link" onClick={howScored} data-testid="rail-how-scored">
          How it is scored ↓
        </button>
      </div>
    </aside>
  )
}
