/**
 * "Local agents" under the ranking of /agents (plan 20261026-tma-local-runner-and-self-declared-results, L11; Q4 = C).
 * The ranking stays hosted-only. A signed-in viewer sees his own local agents here, from GET /agents?include=local.
 * Hidden when the viewer is signed out, while loading, on an error, and when the list is empty.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../../auth/session'
import { api } from '../../lib/api'
import type { Agent } from '../../lib/api'
import { AgentAvatar, AgentOriginPill, ModelLabel, isLocalAgent, routeOfAgent } from '../../tma/ui'
import './local-agents.css'

type State = { status: 'idle' } | { status: 'ready'; agents: Agent[] }

export function LocalAgentsSection() {
  const session = useSession()
  const signedIn = session.status === 'signed-in'
  const [state, setState] = useState<State>({ status: 'idle' })

  useEffect(() => {
    if (!signedIn) {
      setState({ status: 'idle' })
      return
    }
    let alive = true
    api
      .agents({ include: 'local' })
      .then((r) => alive && setState({ status: 'ready', agents: (r.agents ?? []).filter(isLocalAgent) }))
      .catch(() => alive && setState({ status: 'idle' }))
    return () => {
      alive = false
    }
  }, [signedIn])

  if (state.status !== 'ready' || state.agents.length === 0) return null
  return (
    <section className="local-agents" data-testid="local-agents" aria-labelledby="local-agents-title">
      <div className="local-agents__head">
        <h2 className="local-agents__title" id="local-agents-title">
          Local agents
        </h2>
        <span className="local-agents__sub">Run on your machine with the tma CLI. Their results are self-declared and visible only to you.</span>
      </div>
      <ul className="local-agents__list">
        {state.agents.map((a) => {
          const route = routeOfAgent(a)
          return (
            <li key={a.id} className="local-agents__row" data-testid="local-agent-row" data-agent={a.id}>
              <AgentAvatar size={36} id={a.id} name={a.name} src={typeof a.avatarUrl === 'string' ? a.avatarUrl : null} />
              <span className="local-agents__text">
                <span className="local-agents__line">
                  <Link to={`/agents/${encodeURIComponent(a.id)}`} className="local-agents__name">
                    {a.name}
                  </Link>
                  <AgentOriginPill connector={a.connector} />
                </span>
                {a.description && <span className="local-agents__desc">{a.description}</span>}
              </span>
              <span className="local-agents__model" data-testid="local-agent-model">
                <ModelLabel model={a.model} provider={a.providerKey} label={a.model ?? '—'} size={20} />
                <span className="local-agents__route" data-route={route.key}>
                  via {route.name}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
