/** The sections of the public task page (addendum U32, part 3, sections 1 to 9). */
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import type { McpServerView, TaskProfile, TaskResults } from '../../lib/api/types'
import { Badge, Button, ButtonLink, Segmented, StatusChip, TagPill, middle } from '../../tma/ui'
import { copyText, fmtDate, fmtDuration, fmtMemory, fmtScore, useFlash } from './helpers'

function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="tma-card tp-section" id={`sec-${id}`} data-testid={`section-${id}`}>
      <div className="tp-section__head">
        <h2 className="tp-h2">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [flash, setFlash] = useFlash()
  return (
    <button
      type="button"
      className="tp-text-btn"
      onClick={() => {
        void copyText(text)
        setFlash('c')
      }}
    >
      {flash === 'c' ? 'Copied' : label}
    </button>
  )
}

function CodeBlock({ title, text, note }: { title: string; text: string; note?: string }) {
  return (
    <div className="tma-code tp-code">
      <div className="tma-code__header">
        <span className="tma-label">{title}</span>
        <CopyButton text={text} />
      </div>
      <pre className="tma-code__body tp-code__body">{text}</pre>
      {note && <div className="tp-code__note">{note}</div>}
    </div>
  )
}

/* ---------- 1. Goal ---------- */
export function GoalSection({ task }: { task: TaskProfile }) {
  return (
    <Section id="goal" title="Goal">
      <p className="tp-lead" data-testid="goal-text">
        {task.goal.text}
      </p>
      {task.goal.doneWhen.length > 0 && (
        <div className="tp-done">
          <span className="tma-label">Done when</span>
          <ul className="tp-list">
            {task.goal.doneWhen.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}

/* ---------- 2. Input and output ---------- */
export function IoSection({ task }: { task: TaskProfile }) {
  const [full, setFull] = useState(false)
  const text = task.input.instruction.text
  const lines = text ? text.split('\n') : []
  const shown = full ? lines : lines.slice(0, 6)
  const repo = task.input.repository
  const repoText = repo.repo ? `${repo.repo}${repo.commit ? `@${repo.commit}` : ''}` : null
  return (
    <Section id="io" title="Input and output">
      <div className="tp-io">
        <div className="tp-io__card" data-testid="io-input">
          <span className="tma-label">Input</span>
          <Row k="Instruction">
            {text ? (
              <>
                <pre className="tp-instruction" data-testid="instruction">
                  {shown.join('\n')}
                </pre>
                {lines.length > 6 && (
                  <button type="button" className="tp-text-btn" onClick={() => setFull((f) => !f)}>
                    {full ? 'Show less' : 'Show full instruction'}
                  </button>
                )}
              </>
            ) : (
              <span className="tma-muted">The instruction is not published.</span>
            )}
          </Row>
          {repoText && (
            <Row k="Repository">
              <span className="tp-mono13">
                {repoText}
                {repo.path ? ` · ${repo.path}` : ''}
              </span>
            </Row>
          )}
          <Row k="The agent can edit">{task.input.editablePaths.length ? <Mono items={task.input.editablePaths} /> : <span className="tma-muted">—</span>}</Row>
          <Row k="Protected">{task.input.protectedPaths.length ? <Mono items={task.input.protectedPaths} /> : <span className="tma-muted">—</span>}</Row>
          <Row k="Public tests">{task.tests.publicCount != null ? `${task.tests.publicCount} tests the agent can see` : <span className="tma-muted">—</span>}</Row>
        </div>
        <div className="tp-io__card" data-testid="io-output">
          <span className="tma-label">Output</span>
          <Row k="The agent returns">{task.output.summary}</Row>
          <Row k="Checked by">
            {task.output.checkedBy ? <span className="tp-mono13">{task.output.checkedBy}</span> : <span className="tma-muted">—</span>}
            <span className="tma-muted"> in a separate container</span>
          </Row>
          <Row k="Hidden tests">
            {task.output.hiddenCount != null ? `${task.output.hiddenCount} tests` : '—'} <TestsPill task={task} />
          </Row>
        </div>
      </div>
    </Section>
  )
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="tp-row">
      <span className="tp-row__k">{k}</span>
      <div className="tp-row__v">{children}</div>
    </div>
  )
}
const Mono = ({ items }: { items: string[] }) => <span className="tp-mono13">{items.join(', ')}</span>

export function TestsPill({ task }: { task: TaskProfile }) {
  return <TagPill>{task.tests.label === 'open' ? 'Open tests' : 'Sealed tests'}</TagPill>
}

/* ---------- 3. Tools ---------- */
export function ToolsSection({ task }: { task: TaskProfile }) {
  return (
    <Section id="tools" title="Tools">
      <div className="tp-rows" data-testid="tools-list">
        {task.tools.map((t) => (
          <div className={t.allowed ? 'tp-trow' : 'tp-trow tp-trow--off'} key={t.id} data-testid={`tool-${t.id}`}>
            <span className="tp-mono14">{t.name}</span>
            <span className="tma-body-sm tma-muted">{t.description}</span>
            {t.allowed ? <Badge tone="success">Allowed</Badge> : <Badge tone="neutral">Not available</Badge>}
          </div>
        ))}
      </div>
    </Section>
  )
}

/* ---------- 4. MCP servers ---------- */
export function McpSection({ task }: { task: TaskProfile }) {
  const servers = task.mcp.servers
  const [more, setMore] = useState(false)
  const shown = more ? servers : servers.slice(0, 3)
  const pinned = servers.some((s) => s.snapshot.status === 'pinned')
  return (
    <Section id="mcp" title="MCP servers">
      {servers.length === 0 ? (
        <div className="tp-empty" data-testid="mcp-empty">
          No MCP servers in this task. The agent works with the files and the built-in tools.
        </div>
      ) : (
        <>
          <p className="tma-body-sm tma-muted">
            The agent uses these through MCP. Endpoint and token are created for each run. See <a href="#sec-inject">How the config is injected</a>.
          </p>
          {shown.map((s) => (
            <McpCard key={s.name} server={s} version={task.version.number} />
          ))}
          {servers.length > 3 && !more && (
            <button type="button" className="tp-text-btn" onClick={() => setMore(true)}>
              Show {servers.length - 3} more
            </button>
          )}
          <div className="tp-snapshot-foot" data-testid="snapshot-foot">
            {task.mcp.snapshotDigest ? (
              <span className="tp-mono12">
                Schema snapshot pinned to v{task.version.number} · sha256 {middle(task.mcp.snapshotDigest, 4, 4)}
                {servers[0]?.snapshot.capturedAt ? ` · captured ${fmtDate(servers[0].snapshot.capturedAt)}` : ''}
              </span>
            ) : (
              <span className="tp-mono12">Schema snapshot pending for v{task.version.number}</span>
            )}
            {pinned && (
              <a className="tp-text-btn" href={api.publicTaskSchemasUrl(task.slug, task.version.isLatest ? undefined : task.version.number)} download data-testid="schemas-download">
                Download schemas (JSON)
              </a>
            )}
          </div>
        </>
      )}
    </Section>
  )
}

function McpCard({ server: s, version }: { server: McpServerView; version: number }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="tp-server" data-testid={`mcp-${s.name}`}>
      <div className="tp-server__head">
        <span className="tp-mono17">{s.name}</span>
        <TagPill>{s.source === 'catalog' ? 'Itera catalog' : 'Task repo'}</TagPill>
        <span className="tp-badge-mono">{s.transport}</span>
        {s.version && <span className="tp-mono12">{s.version}</span>}
        {s.source === 'repo' && s.reviewedAt && <span className="tp-mono12">Reviewed {fmtDate(s.reviewedAt)}</span>}
      </div>
      {s.retired && <span className="tma-body-sm tma-muted">This server is being replaced in the next version.</span>}
      {s.description && <p className="tma-body-sm tma-muted">{s.description}</p>}
      <div className="tp-server__meta">
        <span>
          {s.seed.applied ? 'Seeded at the start of each run' : 'No seed'}
          {s.seed.digest && <span className="tp-mono12"> · seed sha256 {middle(s.seed.digest, 4, 4)}</span>}
        </span>
        <span>The scorer reads the final state of this server: {s.scorerReadsState ? 'yes' : 'no'}</span>
      </div>
      {s.snapshot.status === 'pending' ? (
        <div className="tp-empty" data-testid={`mcp-${s.name}-pending`}>
          Schema snapshot pending for v{version}. The task allows {s.allowedToolNames.length} tool{s.allowedToolNames.length === 1 ? '' : 's'}:{' '}
          <span className="tp-mono12">{s.allowedToolNames.join(', ')}</span>
        </div>
      ) : (
        <>
          <div className="tp-tools" data-testid={`mcp-${s.name}-tools`}>
            <div className="tp-tools__head">
              <span className="tma-label">Tool</span>
              <span className="tma-label">Description</span>
              <span className="tma-label">Input</span>
            </div>
            {s.tools.map((t) => (
              <div className="tp-tools__item" key={t.name} data-testid="mcp-tool">
                <div className="tp-tools__row">
                  <span className="tp-mono14" data-label="Tool">{t.name}</span>
                  <span className="tma-body-sm tma-muted" data-label="Description">{t.description || '—'}</span>
                  <span className="tp-mono12" data-label="Input">
                    {t.params.length ? t.params.join(', ') : 'no input'}
                    <button type="button" className="tp-chev" aria-expanded={open === t.name} aria-label={`Input schema of ${t.name}`} onClick={() => setOpen(open === t.name ? null : t.name)}>
                      {open === t.name ? '▾' : '▸'}
                    </button>
                  </span>
                </div>
                {open === t.name && <CodeBlock title={`${s.name}_${t.name} · input schema`} text={JSON.stringify(t.inputSchema, null, 2)} />}
              </div>
            ))}
          </div>
          {s.notExposedCount > 0 && (
            <span className="tma-body-sm tma-muted" data-testid="not-exposed">
              {s.notExposedCount} other tool{s.notExposedCount === 1 ? '' : 's'} exist{s.notExposedCount === 1 ? 's' : ''} on this server. They are not available to the agent.
            </span>
          )}
        </>
      )}
    </div>
  )
}

/* ---------- 5. Limits ---------- */
export function LimitsSection({ task }: { task: TaskProfile }) {
  const l = task.limits
  const res = [l.resources.cpus != null ? `${l.resources.cpus} CPU` : null, fmtMemory(l.resources.memoryMb) ? `${fmtMemory(l.resources.memoryMb)} memory` : null].filter(Boolean).join(' · ')
  const rows: Array<[string, ReactNode]> = [
    ['Run timeout', l.runTimeoutSec != null ? `${l.runTimeoutSec} s` : '—'],
    ['Estimated time', l.estMinutes != null ? `~${l.estMinutes} min` : '—'],
    ['Model cost cap', `US$${l.costCapUsd.toFixed(2)} per run`],
    ['Resources', res || '—'],
    ['Network', l.network === 'model-gateway+mcp' ? 'Model API and the MCP servers of this task' : 'Model API only'],
    ['Secrets', l.secrets.length ? <span className="tp-mono13">{l.secrets.join(', ')}</span> : 'None'],
    ['MCP boot timeout', l.mcpBootTimeoutSec != null ? `${l.mcpBootTimeoutSec} s` : '—'],
    ['Editable paths', l.editablePaths.length ? <span className="tp-mono13">{l.editablePaths.join(', ')}</span> : '—'],
    ['Protected paths', l.protectedPaths.length ? <span className="tp-mono13">{l.protectedPaths.join(', ')}</span> : '—'],
  ]
  return (
    <Section id="limits" title="Limits">
      <div className="tp-kv" data-testid="limits">
        {rows.map(([k, v]) => (
          <Row key={k} k={k}>
            {v}
          </Row>
        ))}
      </div>
    </Section>
  )
}

/* ---------- 6. Scoring ---------- */
export function ScoringSection({ task }: { task: TaskProfile }) {
  return (
    <Section id="scoring" title="Scoring">
      <div className="tp-parts" data-testid="score-parts">
        {task.scoring.parts.map((p) => (
          <div className="tp-part" key={p.key}>
            <span className="tp-part__label">{p.label}</span>
            <span className="tp-part__track">
              <span className="tp-part__fill" style={{ width: `${p.points}%` }} />
            </span>
            <span className="tp-part__pts">{p.points}</span>
            <span className="tp-part__desc">{p.description}</span>
          </div>
        ))}
      </div>
      <p className="tma-body-sm tma-muted">Score = the sum of the five parts, 0 to 100.</p>
      {task.mcp.scorerReads.length > 0 && <p className="tma-body-sm tma-muted">The scorer also reads the final state of: <span className="tp-mono13">{task.mcp.scorerReads.join(', ')}</span>.</p>}
      <div className="tp-tests-card" data-testid="tests-card">
        <TestsPill task={task} />
        <span className="tma-body-sm tma-muted">{task.tests.label === 'sealed' ? 'The hidden tests are kept out of the agent sandbox.' : 'The tests are in a public repo. Agent authors can read them.'}</span>
      </div>
    </Section>
  )
}

/* ---------- 7. Version and digest ---------- */
export function VersionSection({ task }: { task: TaskProfile }) {
  const v = task.version
  const d = v.digests
  const rows: Array<[string, string | null]> = [
    ['Contract digest', d.contract],
    ['Environment digest', d.environment],
    ['MCP schema digest', d.mcpSchema],
    ...d.seeds.map((s): [string, string | null] => [`Seed digest · ${s.server}`, s.digest]),
  ]
  return (
    <Section id="version" title="Version">
      <div className="tp-kv" data-testid="version-rows">
        <Row k="Version">
          <span className="tp-mono13">v{v.number}</span> <span className="tma-muted">· {fmtDate(v.createdAt)}</span>
        </Row>
        {v.commit && (
          <Row k="Pinned commit">
            {v.repoUrl ? (
              <a className="tp-mono13" href={`${v.repoUrl}/commit/${v.commit}`} target="_blank" rel="noreferrer">
                {v.commit}
              </a>
            ) : (
              <span className="tp-mono13">{v.commit}</span>
            )}
          </Row>
        )}
        {rows.map(([k, val]) => (
          <Row key={k} k={k}>
            {val ? (
              <span className="tp-digest">
                <span className="tp-mono12" title={val}>
                  sha256 {middle(val, 8, 6)}
                </span>
                <CopyButton text={val} />
              </span>
            ) : (
              <span className="tma-muted">{k.startsWith('MCP') ? 'Schema snapshot pending' : 'Not recorded'}</span>
            )}
          </Row>
        ))}
      </div>
      <p className="tma-body-sm tma-muted">A result links to the version it ran on.</p>
      <div className="tp-history" data-testid="version-history">
        <span className="tma-label">Version history</span>
        {v.history.map((h) => (
          <div className="tp-history__row" key={h.version}>
            {h.version === v.number ? <span className="tp-mono13">v{h.version}</span> : <Link to={h.version === v.latest ? `/tasks/${task.slug}` : `/tasks/${task.slug}?v=${h.version}`} className="tp-mono13">v{h.version}</Link>}
            <span className="tma-body-sm tma-muted">{fmtDate(h.createdAt)}</span>
            <span className="tma-body-sm tma-muted">{h.changed.length ? h.changed.join(' · ') : h.version === 1 ? 'First version' : 'No change recorded'}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

/* ---------- 8. Results (reputation) ---------- */

export function ResultsSection({ task }: { task: TaskProfile }) {
  const [scope, setScope] = useState<'version' | 'all'>('version')
  const r: TaskResults = scope === 'version' ? task.results : task.resultsAll
  const rep = task.reputation
  const total = r.outcomes.pass + r.outcomes.fail + r.outcomes.invalid
  return (
    <Section
      id="results"
      title="Results"
      aside={
        <Segmented
          items={[
            { id: 'version', label: `v${task.version.number}` },
            { id: 'all', label: 'All versions' },
          ]}
          value={scope}
          onChange={setScope}
        />
      }
    >
      {rep && (
        <div className="tp-rep" data-testid="reputation">
          {rep.curatedByItera && (
            <Badge tone="success" testId="curated-badge">
              Curated by Itera
            </Badge>
          )}
          <span className="tma-body-sm tma-muted">
            {rep.runs} run{rep.runs === 1 ? '' : 's'} · {rep.distinctWallets} distinct wallet{rep.distinctWallets === 1 ? '' : 's'} ·{' '}
            {rep.feedbackYesRate == null ? 'no feedback yet' : `${Math.round(rep.feedbackYesRate * 100)}% of ${rep.feedbackCount} answers say the result matched reality`}
          </span>
        </div>
      )}
      {r.runs === 0 ? (
        <div className="tp-empty tp-empty--center" data-testid="results-empty">
          <span className="tp-empty__title">Not run yet.</span>
          <RunLink task={task} />
        </div>
      ) : (
        <>
          <div className="tp-stats" data-testid="results-stats">
            <Stat label="Agents evaluated" value={String(r.agentsEvaluated)} />
            <Stat label="Pass rate" value={r.passRate == null ? '—' : `${Math.round(r.passRate * 100)}%`} />
            <Stat label="Median score" value={fmtScore(r.medianScore)} />
            <Stat label="Median time" value={fmtDuration(r.medianDurationMs)} />
          </div>
          <div className="tp-bar" data-testid="outcome-bar" aria-label={`${r.outcomes.pass} pass, ${r.outcomes.fail} fail, ${r.outcomes.invalid} invalid`}>
            {(['pass', 'fail', 'invalid'] as const).map((k) => (r.outcomes[k] > 0 ? <span key={k} className={`tp-bar__seg tp-bar__seg--${k}`} style={{ flexGrow: r.outcomes[k] }} /> : null))}
          </div>
          <div className="tp-bar__legend">
            <span>PASS {r.outcomes.pass}</span>
            <span>FAIL {r.outcomes.fail}</span>
            <span>INVALID {r.outcomes.invalid}</span>
            <span className="tma-subtle">of {total}</span>
          </div>
          <div className="tp-board" data-testid="leaderboard">
            {r.leaderboard.map((row) => (
              <div className="tp-board__row" key={`${row.rank}-${row.agentName}`} data-testid="leaderboard-row">
                <span className="tp-mono13 tp-board__rank">{row.rank}</span>
                <span className="tp-board__agent">
                  <span className="tp-board__name">{row.agentName}</span>
                  <span className="tma-body-sm tma-muted">{row.modelLabel ?? '—'}</span>
                </span>
                <span className="tp-mono14" data-label="Score">{fmtScore(row.score)}</span>
                <StatusChip status={row.outcome} />
                <span className="tma-body-sm tma-muted">{fmtDate(row.date)}</span>
                {row.evaluationSlug ? (
                  <Link to={`/e/${row.evaluationSlug}`} className="tp-board__link">
                    Evaluation ↗
                  </Link>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <p className="tma-body-sm tma-muted">Public evaluations only. Score is the mean of PASS and FAIL runs. INVALID and platform errors are not scored.</p>
    </Section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="tp-stat">
      <span className="tma-label">{label}</span>
      <span className="tp-stat__v">{value}</span>
    </div>
  )
}

function RunLink({ task }: { task: TaskProfile }) {
  return task.runnable ? (
    <ButtonLink href={`/agents?tasks=${encodeURIComponent(task.slug)}`} variant="primary" size={36}>
      Be the first to evaluate an agent
    </ButtonLink>
  ) : (
    <Button variant="secondary" size={36} disabled>
      Coming soon
    </Button>
  )
}

/* ---------- 9. How the config is injected per run ---------- */
export function InjectSection({ task }: { task: TaskProfile }) {
  const name = task.mcp.servers[0]?.name ?? 'server-name'
  const env = name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const snippet = JSON.stringify({ mcp: { [name]: { type: 'remote', url: `{{MCP_${env}_URL}}`, headers: { Authorization: 'Bearer {{RUN_TOKEN}}' } } } }, null, 2)
  const steps = [
    'Itera pins the task version and its digests.',
    'For each run, the runner starts every MCP server in its own container on the sandbox network. It applies the seed first.',
    'The runner creates a temporary token for this run.',
    'The runner writes the opencode config. It lists only the allowed tools, with the endpoint and token of this run.',
    'The agent runs. It uses the listed tools. It cannot add a server and it cannot reach other hosts.',
    'After the run, a separate scorer container can read the final state of the servers that allow it. The servers and the token are then deleted.',
  ]
  return (
    <Section id="inject" title="How the config is injected per run">
      <div className="tp-inject">
        <ol className="tp-steps" data-testid="inject-steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <div className="tp-flow" aria-hidden="true">
          {['Task version', 'MCP sidecars', 'Run config', 'Agent', 'Scorer'].map((b, i) => (
            <div className="tp-flow__item" key={b}>
              {i > 0 && <span className="tp-flow__arrow">↓</span>}
              <span className="tp-flow__box">{b}</span>
            </div>
          ))}
        </div>
      </div>
      <CodeBlock title="Run config" text={snippet} note="Illustrative. The values are created for each run and are never published." />
      <div className="tp-build" data-testid="build-for-task">
        <span className="tp-build__title">Build for this task</span>
        <ul className="tp-list">
          <li>Use the MCP tools through the config you get. Do not hard-code an endpoint.</li>
          <li>If your agent needs a server, declare it on the Add agent screen. We check before you pay.</li>
        </ul>
      </div>
    </Section>
  )
}
