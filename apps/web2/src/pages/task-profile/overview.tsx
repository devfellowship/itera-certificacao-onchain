/**
 * The overview cards and the runs panel of the task page (plan TMA L14a). Every value comes from
 * GET /public/tasks/:slug, GET /public/evaluations/:slug and GET /runs/:id/actions. No invented value.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import type { TaskProfile, TaskResults } from '../../lib/api/types'
import { ChatView, FieldTable, JsonTree, RunAgentCell, RunsTable, fmtScore, type ChatMessage, type FieldRow, type RunRow } from '../../tma/detail'
import { AgentAvatar, ModelLabel, Segmented } from '../../tma/ui'
import { useEvaluationChecks, useTopRunActions } from './evaluation-cache'
import { copyText, useFlash } from './helpers'

/* ---------- Shared bits ---------- */

export function DetailCard({ title, sub, aside, children, testId }: { title: string; sub?: ReactNode; aside?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="tma-card dt-card" data-testid={testId}>
      <div className="dt-card__head">
        <div className="dt-card__title">
          <strong>{title}</strong>
          {sub && <span className="dt-card__sub">{sub}</span>}
        </div>
        {aside}
      </div>
      <div className="dt-card__body">{children}</div>
    </section>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
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

/** The link to the full input in the task repository (when the API truncated the instruction). */
export function fullInputUrl(task: TaskProfile): string | null {
  const r = task.input.repository
  if (!r.repo) return null
  return `https://github.com/${r.repo}/tree/${r.commit || 'main'}/${r.path ?? ''}`.replace(/\/$/, '')
}

/** Input (n): the input parts of the Input tab — instruction, repository, each MCP server seed. */
export function inputPartsCount(task: TaskProfile): number {
  let n = 0
  if (task.input.instruction.text) n += 1
  if (task.input.repository.repo) n += 1
  n += task.mcp.servers.filter((s) => s.seed.applied).length
  return n
}

/* ---------- Input card: Chat | Raw ---------- */

export function InputCard({ task }: { task: TaskProfile }) {
  const [view, setView] = useState<'chat' | 'raw'>('chat')
  const top = task.results.leaderboard[0] ?? task.resultsAll.leaderboard[0] ?? null
  const run = useTopRunActions(top?.evaluationSlug ?? null, task.slug, task.name)
  const text = task.input.instruction.text ?? ''
  const messages = useMemo<ChatMessage[]>(() => {
    const out: ChatMessage[] = []
    out.push({ role: 'user', index: 'm1', text: text || 'The instruction is not published.' })
    if (run.kind === 'ok' && top) {
      out.push({
        role: 'agent',
        index: top.agentName,
        text: `${run.actions.length} tool call${run.actions.length === 1 ? '' : 's'}${run.hasMore ? ' (first page)' : ''}`,
        avatar: <AgentAvatar id={top.agentSlug ?? top.agentName} name={top.agentName} src={top.agentAvatarUrl} size={28} author={top.ownerProfile ? { name: top.ownerProfile.displayName ?? top.ownerProfile.username, avatarUrl: top.ownerProfile.avatarUrl } : null} />,
      })
      for (const a of run.actions) out.push({ role: 'tool', text: a.target ? `${a.tool} ${a.target}` : a.tool, ok: a.ok })
    }
    if (task.goal.doneWhen.length > 0) out.push({ role: 'grader', index: 'done when', evidence: true, text: task.goal.doneWhen.map((d) => `• ${d}`).join('\n') })
    return out
  }, [text, run, top, task.goal.doneWhen])
  const fullUrl = fullInputUrl(task)
  return (
    <DetailCard
      title="Input"
      sub={`instruction · ${messages.length} message${messages.length === 1 ? '' : 's'}`}
      testId="overview-input"
      aside={
        <Segmented
          items={[
            { id: 'chat', label: 'Chat' },
            { id: 'raw', label: 'Raw' },
          ]}
          value={view}
          onChange={setView}
        />
      }
    >
      {view === 'chat' ? (
        <>
          <ChatView messages={messages} />
          {run.kind === 'loading' && (
            <span className="tma-body-sm tma-muted" data-testid="top-run-loading">
              Loading the tool calls of the top run…
            </span>
          )}
        </>
      ) : (
        <>
          <div className="dt-row-actions">
            <span className="tma-label">Instruction</span>
            <CopyButton text={text} />
          </div>
          {text ? (
            <pre className="dt-pre" data-testid="input-raw">
              {text}
            </pre>
          ) : (
            <span className="tma-muted">The instruction is not published.</span>
          )}
          {task.input.instruction.truncated && fullUrl && (
            <a href={fullUrl} target="_blank" rel="noreferrer" className="tp-text-btn" data-testid="input-full-link">
              Open the full input ↗
            </a>
          )}
        </>
      )}
    </DetailCard>
  )
}

/* ---------- Expected output card: Fields | JSON ---------- */

export function expectedRows(task: TaskProfile): FieldRow[] {
  const partPoints = (key: string) => task.scoring.parts.find((p) => p.key === key)?.points
  const hiddenPts = partPoints('hidden_behavior') ?? partPoints('hidden')
  const publicPts = partPoints('public_tests') ?? partPoints('public') ?? 0
  const rows: FieldRow[] = [
    {
      field: 'patch',
      type: 'diff',
      value: (
        <>
          {task.output.summary}
          {task.input.editablePaths.length > 0 && (
            <>
              {' '}
              <span className="tp-mono12">{task.input.editablePaths.join(', ')}</span>
            </>
          )}
        </>
      ),
      weight: '—',
    },
    {
      field: 'hidden checks',
      type: `tests ×${task.tests.hiddenCount ?? '—'}`,
      value: task.output.checkedBy ? <span className="tp-mono12">{task.output.checkedBy}</span> : '—',
      weight: hiddenPts ?? '—',
    },
    { field: 'public tests', type: `tests ×${task.tests.publicCount ?? '—'}`, value: 'visible to the agent', weight: publicPts },
    ...(task.scoring.gates ?? []).map((g): FieldRow => ({ field: 'gate', type: 'gate', value: g, weight: 'gate' })),
    ...task.mcp.scorerReads.map((s): FieldRow => ({ field: s, type: 'final state', value: 'The scorer reads the final state of this server.', weight: '—' })),
  ]
  return rows
}

export function ExpectedOutputCard({ task, full }: { task: TaskProfile; full?: boolean }) {
  const [view, setView] = useState<'fields' | 'json'>('fields')
  const rows = expectedRows(task)
  const pinned = task.mcp.servers.some((s) => s.snapshot.status === 'pinned')
  return (
    <DetailCard
      title="Expected output"
      testId={full ? 'expected-full' : 'overview-expected'}
      aside={
        <Segmented
          items={[
            { id: 'fields', label: 'Fields' },
            { id: 'json', label: 'JSON' },
          ]}
          value={view}
          onChange={setView}
        />
      }
    >
      {view === 'fields' ? <FieldTable rows={rows} /> : <JsonTree value={{ output: task.output, tests: task.tests, scoring: task.scoring }} collapsedDepth={2} />}
      {full && pinned && (
        <a className="tp-text-btn" href={api.publicTaskSchemasUrl(task.slug, task.version.isLatest ? undefined : task.version.number)} download data-testid="expected-schemas-download">
          Download schemas (JSON)
        </a>
      )}
    </DetailCard>
  )
}

/* ---------- Runs panel ---------- */

export function RunsPanel({ task, limit, onAll }: { task: TaskProfile; limit?: number; onAll?: () => void }) {
  const [scope, setScope] = useState<'counted' | 'all'>('counted')
  const r: TaskResults = scope === 'counted' ? task.results : task.resultsAll
  const board = limit ? r.leaderboard.slice(0, limit) : r.leaderboard
  const checks = useEvaluationChecks(
    board.map((b) => b.evaluationSlug),
    task.slug,
    task.name,
  )
  const best = r.leaderboard.reduce<number | null>((m, b) => (b.score != null && (m == null || b.score > m) ? b.score : m), null)
  const rows: RunRow[] = board.map((b) => {
    const href = b.evaluationSlug ? `/e/${b.evaluationSlug}` : undefined
    const owner = b.ownerProfile?.displayName || b.ownerProfile?.username || null
    return {
      key: `${b.rank}-${b.agentSlug ?? b.agentName}`,
      rank: b.rank,
      agent: (
        <RunAgentCell
          href={href}
          name={b.agentName}
          owner={owner ? `by ${owner}` : undefined}
          avatar={<AgentAvatar id={b.agentSlug ?? b.agentName} name={b.agentName} src={b.agentAvatarUrl} size={32} author={b.ownerProfile ? { name: owner, avatarUrl: b.ownerProfile.avatarUrl } : null} />}
        />
      ),
      model: b.modelLabel ? <ModelLabel label={b.modelLabel} size={16} /> : null,
      // Public catalog runs are all hosted runs (apps/api/src/public/task-profile.ts reads the runs table only).
      source: 'run here',
      score: b.score,
      checks: b.evaluationSlug ? checks[b.evaluationSlug] : null,
      outcome: b.outcome,
      href,
    }
  })
  return (
    <section className="dt-card tma-card" data-testid="runs-panel">
      <div className="dt-card__head">
        <div className="dt-card__title">
          <strong>Runs</strong>
          <span className="dt-card__sub" data-testid="runs-summary">
            {r.outcomes.pass} of {r.runs} passed · best {fmtScore(best)}
          </span>
        </div>
        <Segmented
          items={[
            { id: 'counted', label: `Counted · v${task.version.number}` },
            { id: 'all', label: 'All versions' },
          ]}
          value={scope}
          onChange={setScope}
        />
      </div>
      <div className="dt-card__body">
        <RunsTable rows={rows} />
        {limit && r.leaderboard.length > 0 && (
          <div className="dt-row-actions">
            <span className="tma-body-sm tma-muted">Top {Math.min(limit, r.leaderboard.length)} agents of {r.runs} runs. The leaderboard keeps one row per agent.</span>
            {onAll ? (
              <button type="button" className="tp-text-btn" onClick={onAll} data-testid="runs-all-link">
                All runs →
              </button>
            ) : (
              <Link to={`/tasks/${task.slug}?tab=runs`} className="tp-text-btn" data-testid="runs-all-link">
                All runs →
              </Link>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
