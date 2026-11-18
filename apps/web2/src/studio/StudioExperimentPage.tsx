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
 *
 * Layout (redesign C5-RD-S5, canvas artboard "S5 Experiment"): a trail bar, the title, then 1 Base agent (a card with a
 * Change list), 2 Agent variant (the variants, then the part table base vs variant, the change block and the agent version
 * line), 3 Dataset and uploaded runs; at the right a sidebar with the experiment in plain words, where it runs (the copy
 * command) and the digests folded. The artboard's Hypothesis field, "Save variant" and "Hosted sandbox" are not here:
 * studio v1 stores nothing and launches nothing (ADR-5). The diff text stays on the host: the server keeps its digest.
 */
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { EvalAgentVersion, EvalCaseListItem, EvalRun, EvalVariant } from '../lib/api/types'
import { Badge, Checkbox, SearchInput } from '../tma/ui'
import { Crumb, CrumbSep, InfoTip, Step, StudioBar, TitleRow } from './chrome'
import { CopyCommand } from './CopyCommand'
import { DEFAULT_REPEAT, experimentScript } from './eval-command'
import { changeWords, partRows, plannedRuns } from './experiment-parts'
import { agentHref } from './links'
import { changeText, evaluationHref, runHref, sha12, statusTone } from './runs'
import { themeClass } from './theme'
import { splitUseCaseKey } from './use-case'
import { loadErrorText, useStudioLoad } from './useStudioLoad'
import './studio.css'
import './experiment-page.css'

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


const EXPERIMENT_TIP =
  'An experiment runs one agent variant (the base agent plus one change) over a dataset of test cases, then compares it with the base agent. Studio v1 stores nothing: you run the commands on your host with tma eval and upload the runs.'

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
  // The trail names the use case of the ?case= filter when the case list knows it.
  const useCase = loaded.state === 'ok' && caseFilter ? (loaded.data.cases.find((c) => c.id === caseFilter)?.useCaseKey ?? null) : null
  const uc = useCase ? splitUseCaseKey(useCase) : null
  return (
    <main className={themeClass('tma-page', 'stu-page', 'xp-page')} data-testid="studio-experiment-page">
      <StudioBar
        trail={
          <>
            <Link to="/studio" data-testid="studio-back">
              Studio
            </Link>
            {uc && (
              <>
                <CrumbSep />
                <Crumb>{uc.type}</Crumb>
                {uc.subtype && (
                  <>
                    <CrumbSep />
                    <Crumb>{uc.subtype}</Crumb>
                  </>
                )}
              </>
            )}
            <CrumbSep />
            <Link to={caseFilter ? `/studio/experiments?case=${encodeURIComponent(caseFilter)}` : '/studio/experiments'}>experiments</Link>
            <CrumbSep />
            <Crumb current>new experiment</Crumb>
          </>
        }
      />
      {loaded.state === 'loading' && (
        <div className="stu-body">
          <p className="tma-body-sm tma-muted" data-testid="studio-loading">
            Loading uploaded runs…
          </p>
        </div>
      )}
      {loaded.state === 'error' && (
        <div className="xp-layout">
          <div className="stu-body xp-main">
            <Title />
            <div className="xp-card" data-testid="studio-empty">
              <span className="tma-label">No uploaded runs to show</span>
              <p className="tma-body-sm tma-muted" data-testid="studio-load-error">
                {loadErrorText(loaded.status)}
              </p>
              <AgentLinks agents={new Map()} agentFilter={agentFilter} />
            </div>
          </div>
          <aside className="xp-side" aria-label="The experiment">
            <CopyCommand title="Experiment commands (on your host)" testId="experiment-copy-command" command={experimentScript({ cases: [], agentId: agentFilter })} />
          </aside>
        </div>
      )}
      {loaded.state === 'ok' && <ExperimentView data={loaded.data} agentFilter={agentFilter} caseFilter={caseFilter} />}
    </main>
  )
}

function Title() {
  return (
    <TitleRow tip={<InfoTip label="About experiments" text={EXPERIMENT_TIP} />}>
      <h1 className="tma-h1">New experiment</h1>
    </TitleRow>
  )
}

function AgentLinks({ agents, agentFilter }: { agents: Map<string, string | null>; agentFilter: string | null }) {
  // The ?agent= filter names an agent even when it has no uploaded run yet: the way back to its page must exist then too.
  const all = new Map(agents)
  if (agentFilter && !all.has(agentFilter)) all.set(agentFilter, null)
  return (
    <p className="tma-body-sm xp-agents" data-testid="experiment-agent-links">
      <span className="tma-muted">{all.size ? 'TMA agent:' : 'No TMA agent yet.'}</span>
      {[...all.entries()].map(([id, name]) => (
        <Link key={id} to={agentHref(id)} data-testid="experiment-agent-link">
          {name ?? id.slice(0, 8)}
        </Link>
      ))}
      <Link to="/agents/new" data-testid="experiment-new-agent">
        New agent
      </Link>
    </p>
  )
}

const agentName = (a: EvalAgentVersion) => `${a.harness}${a.harnessVersion ? ` ${a.harnessVersion}` : ''} · ${a.modelId}`
const letters = (h: string) => (/claude/i.test(h) ? 'CC' : /codex/i.test(h) ? 'CX' : /opencode/i.test(h) ? 'OC' : h.slice(0, 2).toUpperCase())
const ground = (h: string) => (/claude/i.test(h) ? 'cc' : /codex/i.test(h) ? 'cx' : /opencode/i.test(h) ? 'oc' : 'al')

function AgentTile({ agent }: { agent: EvalAgentVersion }) {
  return (
    <span className="xp-tile" aria-hidden="true">
      <span className={`xp-tile__ground xp-tile__ground--${ground(agent.harness)}`}>{letters(agent.harness)}</span>
      <span className="xp-tile__badge">{(agent.modelId.replace(/^.*\//, '')[0] ?? '?').toUpperCase()}</span>
    </span>
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
  const datasetCases = [...dataset]
    .map((id) => {
      const c = caseById.get(id)
      if (c) return { caseKey: c.caseKey, useCaseKey: c.useCaseKey, mode: c.mode }
      const r = data.runs.find((x) => x.caseId === id)
      return r ? { caseKey: r.caseKey, useCaseKey: r.useCaseKey, mode: 'replay' } : null
    })
    .filter((c): c is { caseKey: string; useCaseKey: string; mode: string } => !!c)
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
  const parts = base ? partRows(base.agent, chosen?.variant.changeKind ?? 'none') : []
  const changed = parts.find((p) => p.changed) ?? null
  const runs = plannedRuns(datasetCases, DEFAULT_REPEAT)
  const [changing, setChanging] = useState(false)

  return (
    <div className="xp-layout">
      <div className="stu-body xp-main">
        <Title />

        <Step n={1} title="Base agent" data-testid="experiment-base-agent">
          {base ? (
            <div className="xp-card xp-base">
              <AgentTile agent={base.agent} />
              <span className="xp-base__text">
                <b>{agentName(base.agent)}</b>
                <span className="xp-mono-sub">
                  {sha12(base.agentSha256)} · the base agent of {variants.length} {variants.length === 1 ? 'variant' : 'variants'} in your uploads
                </span>
              </span>
              {bases.length > 1 && (
                <button type="button" className="xp-link-btn" aria-expanded={changing} onClick={() => setChanging((x) => !x)} data-testid="experiment-change-base">
                  Change
                </button>
              )}
            </div>
          ) : (
            <p className="tma-body-sm tma-muted" data-testid="experiment-empty">
              No uploaded eval runs{agentFilter ? ' for this agent' : ''}
              {caseFilter ? ' on this case' : ''} yet. Build the commands at the right, run them on your host, and upload.
            </p>
          )}
          {bases.length > 1 && (
            <div className="xp-choices" role="radiogroup" aria-label="Base agent" hidden={!changing}>
              {bases.map((b) => (
                <label key={b.agentSha256} className="xp-choice" data-testid="experiment-base-choice">
                  <input type="radio" name="base" checked={b === base} onChange={() => (setBaseSha(b.agentSha256), setVariantId(null), setPicked(null), setChanging(false))} />
                  <span className="tma-mono">
                    {agentName(b.agent)} · {sha12(b.agentSha256)}
                  </span>
                </label>
              ))}
            </div>
          )}
          <AgentLinks agents={base?.agents ?? new Map()} agentFilter={agentFilter} />
        </Step>

        <Step n={2} title="Agent variant: change one thing" data-testid="experiment-variants">
          {variants.length === 0 ? (
            <p className="tma-body-sm tma-muted">No variant yet. The commands at the right use your own tma-variant/1 file.</p>
          ) : (
            <div className="xp-variants" role="radiogroup" aria-label="Variant">
              {variants.map((v) => (
                <label key={v.variant.id} className={`xp-variant${v === chosen ? ' xp-variant--on' : ''}`} data-testid="experiment-variant">
                  <input type="radio" name="variant" checked={v === chosen} onChange={() => setVariantId(v.variant.id)} />
                  <span>
                    <b>{v.variant.label}</b> <span className="tma-muted">· {changeText(v.variant.changeKind)}</span> <span className="xp-mono-sub">{sha12(v.variant.variantSha256)}</span>{' '}
                    <span className="tma-muted">
                      · {v.runs.length} {v.runs.length === 1 ? 'run' : 'runs'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {base && (
            <div className="xp-parts" role="table" aria-label="Base agent and variant, part by part" data-testid="experiment-parts">
              <div className="xp-parts__row xp-parts__head" role="row">
                <span role="columnheader">part of the agent</span>
                <span role="columnheader">base</span>
                <span role="columnheader">variant</span>
              </div>
              {parts.map((p, i) => (
                <div key={p.key} role="rowgroup">
                  {p.group === 'tools' && parts[i - 1]?.group !== 'tools' && (
                    <div className="xp-parts__group" role="row">
                      <span role="cell">Tools &amp; permissions · the agent's own, not the environment</span>
                    </div>
                  )}
                  <div className={`xp-parts__row${p.changed ? ' xp-parts__row--on' : ''}`} role="row" data-testid="experiment-part" data-part={p.key} data-changed={p.changed ? 'true' : undefined}>
                    <span role="cell" className="xp-parts__label">
                      {p.label}
                    </span>
                    <span role="cell" className={p.base ? 'xp-parts__base' : 'xp-parts__base tma-muted'}>
                      {p.base ?? 'not in the agent version'}
                    </span>
                    <span role="cell">
                      {p.changed && chosen ? (
                        <span className="xp-edited">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                          </svg>
                          {changeWords(chosen.variant.changeKind)}
                        </span>
                      ) : (
                        <span className="xp-same">= same</span>
                      )}
                    </span>
                  </div>
                  {p.changed && chosen && (
                    <div className="xp-diff" data-testid="experiment-diff">
                      <div className="xp-diff__line xp-diff__line--ctx">
                        {'  '}## {p.label}
                      </div>
                      <div className="xp-diff__line xp-diff__line--del">- base: {p.base ?? 'not in the agent version'}</div>
                      <div className="xp-diff__line xp-diff__line--add">
                        + {chosen.variant.label}: one {chosen.variant.changeKind} diff, digest {sha12(chosen.variant.variantSha256)}
                      </div>
                      <div className="xp-diff__line xp-diff__line--ctx">{'  '}The diff text stays on your host; the server keeps its digest.</div>
                    </div>
                  )}
                </div>
              ))}
              <p className="xp-version" data-testid="experiment-version">
                <span className="tma-muted">agent version</span>
                <span className="xp-mono-sub">
                  {base.agent.harness} · {base.agent.modelId.replace(/^.*\//, '')} · {sha12(base.agentSha256)}
                </span>
                <span aria-hidden="true">→</span>
                <span className="xp-mono-sub xp-version__new">{chosen && chosen.variant.changeKind !== 'none' ? `+ ${chosen.variant.changeKind} ${sha12(chosen.variant.variantSha256)}` : 'unchanged'}</span>
                <span className="tma-muted">{changed ? `only the ${changed.label.toLowerCase()} change` : 'the base agent as it is'}</span>
              </p>
            </div>
          )}
        </Step>

        <Step n={3} title="Dataset and uploaded runs" data-testid="experiment-dataset">
          {data.casesError != null ? (
            <p className="tma-body-sm tma-muted">{loadErrorText(data.casesError)}</p>
          ) : data.cases.length === 0 ? (
            <p className="tma-body-sm tma-muted">No test case uploaded yet.</p>
          ) : (
            <div className="xp-dataset">
              <div className="xp-dataset__head">
                <span className="tma-label">
                  {dataset.size} test {dataset.size === 1 ? 'case' : 'cases'} picked
                </span>
                <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter test cases" aria-label="Filter test cases" />
              </div>
              <ul className="xp-dataset__list">
                {shown.map((c) => (
                  <li key={c.id} data-testid="experiment-dataset-case">
                    <Checkbox
                      checked={dataset.has(c.id)}
                      onChange={() => toggle(c.id)}
                      label={
                        <span className="tma-mono">
                          {c.caseKey} <span className="tma-muted">({c.useCaseKey})</span>
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="xp-runs" data-testid="experiment-runs">
            {rows.length === 0 ? (
              <p className="tma-body-sm tma-muted">No uploaded runs.</p>
            ) : (
              <table className="xp-table">
                <thead>
                  <tr>
                    <th>case</th>
                    <th>variant</th>
                    <th>runs{data.truncated ? ` (newest ${data.limit})` : ''}</th>
                    <th>evaluations</th>
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
                      <td>
                        <span className="stu-tags">
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
                        </span>
                      </td>
                      <td>
                        <span className="stu-tags">
                          {[...new Set(c.runs.map((r) => r.evaluationId).filter((x): x is string => !!x))].map((e) => (
                            <Link key={e} to={evaluationHref(e)} className="tma-mono" data-testid="experiment-evaluation-link">
                              {e.slice(0, 8)}
                            </Link>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Step>
      </div>

      <aside className="xp-side" aria-label="The experiment" data-testid="experiment-sidebar">
        <section className="xp-side__sec">
          <h2 className="xp-side__kicker">The experiment</h2>
          <p className="xp-side__lead" data-testid="experiment-summary">
            {chosen ? (
              <>
                The variant <b>{chosen.variant.label}</b> runs{' '}
                <b>
                  {datasetCases.length} {datasetCases.length === 1 ? 'case' : 'cases'}
                </b>
                , each <b>{DEFAULT_REPEAT} times</b>, so <b>{runs} runs</b>. Its runs then sit next to those of the base agent.
              </>
            ) : (
              <>
                Your variant runs <b>{datasetCases.length} {datasetCases.length === 1 ? 'case' : 'cases'}</b>, each {DEFAULT_REPEAT} times, so <b>{runs} runs</b>.
              </>
            )}
          </p>
        </section>
        <section className="xp-side__sec">
          <h3 className="xp-side__h">Where it runs</h3>
          <p className="xp-where">
            <span className="xp-where__dot" aria-hidden="true" />
            On your machine <span className="tma-muted">· code stays local</span>
          </p>
          <CopyCommand title="Experiment commands" testId="experiment-copy-command" command={script} />
        </section>
        <details className="xp-side__tech">
          <summary>Technical details</summary>
          <dl className="xp-dl">
            <dt>Base agent</dt>
            <dd className="tma-mono">{base ? sha12(base.agentSha256) : '—'}</dd>
            <dt>Variant</dt>
            <dd className="tma-mono">{chosen ? sha12(chosen.variant.variantSha256) : '—'}</dd>
            <dt>Harness repo</dt>
            <dd className="tma-mono">{base?.agent.harnessRepoSha ? sha12(base.agent.harnessRepoSha) : '—'}</dd>
            <dt>Rules</dt>
            <dd className="tma-mono">{sha12(base?.agent.rulesSha256)}</dd>
          </dl>
        </details>
      </aside>
    </div>
  )
}
