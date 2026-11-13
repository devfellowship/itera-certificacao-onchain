/**
 * S5 Experiment (plan 20261112-tma-c5-studio-area-web2, task C5-T3), route /studio/experiments/new?agent=&case=.
 * READ ONLY (ADR-5): no Save, no Start, no Run. An experiment is not stored: it is derived from uploaded runs
 * (runs grouped by case x variant; there is no experiment table). The page shows the base agents of the caller's
 * uploads, the variants of the chosen base agent with their change, the uploaded runs per case x variant, and a
 * copy-command builder: one base agent + one variant + a dataset of cases -> the exact `tma eval` commands the
 * user runs on their host and uploads.
 * Data: GET /eval-runs (filtered by ?agent= and ?case=) and GET /eval-cases (the dataset choices).
 * The case filter of the dataset is a plain text filter on the case key and use case: the task filter of
 * SelectTasksPage filters catalog tasks for a hosted run, which a test case is not.
 */
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { EvalAgentVersion, EvalCaseListItem, EvalRun, EvalVariant } from '../lib/api/types'
import { Badge, Card, CardHeader, Checkbox, SearchInput } from '../tma/ui'
import { CopyCommand } from './CopyCommand'
import { experimentScript } from './eval-command'
import { changeText, evaluationHref, runHref, sha12, statusTone } from './runs'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'

type BaseAgent = {
  agentSha256: string
  agent: EvalAgentVersion
  /** The TMA agents (id -> name) whose evaluations hold runs of this base agent. */
  agents: Map<string, string | null>
  variants: Map<string, { variant: EvalVariant; runs: EvalRun[] }>
}

/** Group the uploaded runs: base agent (agent sha) -> variant -> runs. */
export function baseAgentsOf(runs: EvalRun[]): BaseAgent[] {
  const out = new Map<string, BaseAgent>()
  for (const r of runs) {
    const v = r.variant
    const b = out.get(v.agentSha256) ?? { agentSha256: v.agentSha256, agent: v.agent, agents: new Map(), variants: new Map() }
    if (r.agentId) b.agents.set(r.agentId, r.agentName)
    const e = b.variants.get(v.id) ?? { variant: v, runs: [] }
    e.runs.push(r)
    b.variants.set(v.id, e)
    out.set(v.agentSha256, b)
  }
  return [...out.values()]
}

type Data = { runs: EvalRun[]; truncated: boolean; limit: number; cases: EvalCaseListItem[]; casesError: number | null }

export function StudioExperimentPage() {
  const [params] = useSearchParams()
  const agentFilter = params.get('agent')
  const caseFilter = params.get('case')
  const loaded = useStudioLoad<Data>(
    () =>
      Promise.all([
        api.evalRuns({ agent: agentFilter, case: caseFilter }),
        api.evalCases().then(
          (r) => ({ cases: r.cases, error: null as number | null }),
          (e: { status?: number }) => ({ cases: [] as EvalCaseListItem[], error: e?.status ?? 0 }),
        ),
      ]).then(([r, c]) => ({ runs: r.runs, truncated: r.truncated, limit: r.limit, cases: c.cases, casesError: c.error })),
    [agentFilter, caseFilter],
  )
  return (
    <main className="tma-page" data-testid="studio-experiment-page">
      <p className="tma-body-sm">
        <Link to="/studio">Studio</Link> / experiment
      </p>
      <div className="stu-head">
        <h1 className="tma-h1">Experiment</h1>
        <p className="stu-sub">One base agent, one variant, a dataset of test cases. You run it on your host with tma eval, then upload. Read only.</p>
      </div>
      {loaded.state === 'loading' && (
        <Card pad data-testid="studio-loading">
          <span className="tma-body-sm tma-muted">Loading uploaded runs…</span>
        </Card>
      )}
      {loaded.state === 'error' && (
        <>
          <Card pad data-testid="studio-empty">
            <span className="tma-label">No uploaded runs to show</span>
            <p className="tma-body-sm tma-muted" data-testid="studio-load-error">
              {loadErrorText(loaded.status)}
            </p>
            <AgentLinks agents={new Map()} />
          </Card>
          <Card pad>
            <CopyCommand title="Experiment commands (on your host)" testId="experiment-copy-command" command={experimentScript({ cases: [], agentId: agentFilter })} />
          </Card>
        </>
      )}
      {loaded.state === 'ok' && <ExperimentView data={loaded.data} agentFilter={agentFilter} caseFilter={caseFilter} />}
    </main>
  )
}

function AgentLinks({ agents }: { agents: Map<string, string | null> }) {
  return (
    <p className="tma-body-sm stu-tags" data-testid="experiment-agent-links">
      {[...agents.entries()].map(([id, name]) => (
        <Link key={id} to={`/agents/${encodeURIComponent(id)}`} data-testid="experiment-agent-link">
          {name ?? id.slice(0, 8)}
        </Link>
      ))}
      <Link to="/agents/new" data-testid="experiment-new-agent">
        New agent
      </Link>
    </p>
  )
}

function ExperimentView({ data, agentFilter, caseFilter }: { data: Data; agentFilter: string | null; caseFilter: string | null }) {
  const bases = useMemo(() => baseAgentsOf(data.runs), [data.runs])
  const [baseSha, setBaseSha] = useState<string | null>(null)
  const base = bases.find((b) => b.agentSha256 === baseSha) ?? bases[0] ?? null
  const variants = base ? [...base.variants.values()] : []
  const [variantId, setVariantId] = useState<string | null>(null)
  const chosen = variants.find((v) => v.variant.id === variantId) ?? variants.find((v) => v.variant.changeKind !== 'none') ?? variants[0] ?? null

  // The dataset: the cases of the caller. Default: the ?case= filter, else the cases this base agent ran on.
  const caseById = useMemo(() => new Map(data.cases.map((c) => [c.id, c])), [data.cases])
  const defaultDataset = useMemo(() => {
    if (caseFilter) return new Set([caseFilter])
    return new Set(variants.flatMap((v) => v.runs.map((r) => r.caseId)))
  }, [caseFilter, base?.agentSha256])
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const dataset = picked ?? defaultDataset
  const [q, setQ] = useState('')
  const shown = data.cases.filter((c) => !q || c.caseKey.includes(q.toLowerCase()) || c.useCaseKey.includes(q.toLowerCase()))

  // Runs per case x variant of the chosen base agent.
  const cells = new Map<string, { caseKey: string; variant: EvalVariant; runs: EvalRun[] }>()
  for (const v of variants) {
    for (const r of v.runs) {
      const key = `${r.caseId}|${v.variant.id}`
      const c = cells.get(key) ?? { caseKey: r.caseKey, variant: v.variant, runs: [] }
      c.runs.push(r)
      cells.set(key, c)
    }
  }
  const rows = [...cells.values()].sort((a, b) => a.caseKey.localeCompare(b.caseKey) || a.variant.label.localeCompare(b.variant.label))

  const agentId = agentFilter ?? (base ? [...base.agents.keys()][0] ?? null : null)
  const datasetCases = [...dataset].map((id) => {
    const c = caseById.get(id)
    if (c) return { caseKey: c.caseKey, useCaseKey: c.useCaseKey, mode: c.mode }
    const r = data.runs.find((x) => x.caseId === id)
    return r ? { caseKey: r.caseKey, useCaseKey: r.useCaseKey, mode: 'replay' } : null
  }).filter((c): c is { caseKey: string; useCaseKey: string; mode: string } => !!c)
  const script = experimentScript({
    cases: datasetCases.sort((a, b) => a.caseKey.localeCompare(b.caseKey)),
    agentId,
    variant: chosen ? { label: chosen.variant.label, changeKind: chosen.variant.changeKind, variantSha256: chosen.variant.variantSha256 } : null,
  })
  const toggle = (id: string) => {
    const next = new Set(dataset)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  return (
    <>
      <Card data-testid="experiment-base-agent">
        <CardHeader title="Base agent" meta={bases.length ? `${bases.length} in your uploads` : undefined} />
        <div className="stu-pad">
          {bases.length === 0 ? (
            <p className="tma-body-sm tma-muted" data-testid="experiment-empty">
              No uploaded eval runs{agentFilter ? ' for this agent' : ''}{caseFilter ? ' on this case' : ''} yet. Build the commands below, run them on your host, and upload.
            </p>
          ) : (
            <div className="stu-choices" role="radiogroup" aria-label="Base agent">
              {bases.map((b) => (
                <label key={b.agentSha256} className="stu-choice" data-testid="experiment-base-choice">
                  <input type="radio" name="base" checked={b === base} onChange={() => (setBaseSha(b.agentSha256), setVariantId(null), setPicked(null))} />
                  <span className="tma-mono">
                    {b.agent.harness}
                    {b.agent.harnessVersion ? ` ${b.agent.harnessVersion}` : ''} · {b.agent.modelId} · {sha12(b.agentSha256)}
                  </span>
                </label>
              ))}
            </div>
          )}
          <AgentLinks agents={base?.agents ?? new Map()} />
        </div>
      </Card>

      <Card data-testid="experiment-variants">
        <CardHeader title="Variants" meta={base ? `${variants.length} of this base agent` : undefined} />
        <div className="stu-pad">
          {variants.length === 0 ? (
            <p className="tma-body-sm tma-muted">No variant yet. The commands below use your own tma-variant/1 file.</p>
          ) : (
            <div className="stu-choices" role="radiogroup" aria-label="Variant">
              {variants.map((v) => (
                <label key={v.variant.id} className="stu-choice" data-testid="experiment-variant">
                  <input type="radio" name="variant" checked={v === chosen} onChange={() => setVariantId(v.variant.id)} />
                  <span>
                    {v.variant.label} <span className="tma-muted">· {changeText(v.variant.changeKind)}</span>{' '}
                    <span className="tma-mono tma-muted">{sha12(v.variant.variantSha256)}</span> · {v.runs.length} runs
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card data-testid="experiment-runs">
        <CardHeader title="Uploaded runs per case x variant" meta={data.truncated ? `newest ${data.limit}` : undefined} />
        {rows.length === 0 ? (
          <p className="stu-pad tma-body-sm tma-muted">No uploaded runs.</p>
        ) : (
          <table className="stu-table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Variant</th>
                <th>Runs</th>
                <th>Evaluations</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={`${c.caseKey}|${c.variant.id}`} data-testid="experiment-cell">
                  <td className="tma-mono">
                    <Link to={`/studio/cases/${encodeURIComponent(c.runs[0]!.caseId)}`}>{c.caseKey}</Link>
                  </td>
                  <td>
                    {c.variant.label} <span className="tma-muted">· {changeText(c.variant.changeKind)}</span>
                  </td>
                  <td className="stu-tags">
                    {c.runs
                      .slice()
                      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
                      .map((r) => {
                        const href = runHref(r)
                        const badge = <Badge tone={statusTone(r.status)}>{`#${r.seq ?? '?'} ${r.status}`}</Badge>
                        return href ? (
                          <Link key={r.id} to={href} data-testid="experiment-run-link">
                            {badge}
                          </Link>
                        ) : (
                          <span key={r.id}>{badge}</span>
                        )
                      })}
                  </td>
                  <td className="stu-tags">
                    {[...new Set(c.runs.map((r) => r.evaluationId).filter((x): x is string => !!x))].map((e) => (
                      <Link key={e} to={evaluationHref(e)} className="tma-mono" data-testid="experiment-evaluation-link">
                        {e.slice(0, 8)}
                      </Link>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card data-testid="experiment-dataset">
        <CardHeader title="Dataset" meta={`${dataset.size} test ${dataset.size === 1 ? 'case' : 'cases'} picked`} />
        <div className="stu-pad">
          {data.casesError != null ? (
            <p className="tma-body-sm tma-muted">{loadErrorText(data.casesError)}</p>
          ) : data.cases.length === 0 ? (
            <p className="tma-body-sm tma-muted">No test case uploaded yet.</p>
          ) : (
            <>
              <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter test cases" aria-label="Filter test cases" />
              <ul className="stu-cases">
                {shown.map((c) => (
                  <li key={c.id} data-testid="experiment-dataset-case">
                    <Checkbox checked={dataset.has(c.id)} onChange={() => toggle(c.id)} label={<span className="tma-mono">{c.caseKey} <span className="tma-muted">({c.useCaseKey})</span></span>} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Card>

      <Card pad>
        <CopyCommand title="Experiment commands (on your host)" testId="experiment-copy-command" command={script} />
      </Card>
    </>
  )
}
