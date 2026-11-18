// @vitest-environment jsdom
/**
 * MT-08 (plan 20261118-melhorias-tma, Tainan TG 32382): an S3 shell step shows its decisiongraph category and a short
 * command summary, not the repo it ran in; the waterfall bars and legend use the categories. The span fixtures copy the
 * fields of real layer-1 spans (shape, intent, target) from session-trajectory; the command text is synthetic.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { TraceView } from './studio/StudioTracePage'
import { CATEGORY_LABEL, INTENTS, buildWaterfall, categoryKey, categoryLegend, commandSummary, spanCategory, stepLabel, type Trace, type TraceRun, type TraceSpan } from './studio/traces'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// vitest runs from apps/web2.
const themeCss = readFileSync(join(process.cwd(), 'src/studio/theme.css'), 'utf8')
const tracesCss = readFileSync(join(process.cwd(), 'src/studio/traces.css'), 'utf8')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
})

const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()
const span = (seq: number, over: Partial<TraceSpan> = {}): TraceSpan => ({
  seq, turn_seq: 1, ts: at(seq * 1000), ts_end: at(seq * 1000 + 500), dur_ms: 500, tool: 'Bash', shape: null, intent: null, family: 'shell', target_kind: null, target: null, ok: true, retry_of: null, child_run: null, preview: null, bytes_out: null, ...over,
})
const REPO = { target_kind: 'repo', target: 'devfellowship/dfl-mcp-server' }
const run = (spans: TraceSpan[]): TraceRun => ({
  agent_id: null, parent_agent_id: null, is_subagent: false, spawn_depth: 0, agent_type: null, description: null, title: null, started_at: at(0), ended_at: at(60_000), duration_s: 60, models: [], n_tool_calls: spans.length, errors: 0, spans,
})
const trace = (spans: TraceSpan[]): Trace => ({
  session_id: 'sid', agent_id: null,
  index: { host: null, harness: null, kind: null, first_ts: null, last_ts: null, message_count: null, models: [], state: null },
  candidate: null, pin: null, task_summary: null,
  summary: { title: 'fixture-title', started_at: at(0), ended_at: at(60_000), duration_s: 60, active_s: null, channel: null, models: [], n_runs: 1, n_subagent_runs: 0, n_tool_calls: spans.length, tool_counts: null, intent_counts: null, errors: 0, outcome_signals: null, closure_confidence: null, cost_usd: null, extractor_version: null },
  runs: [run(spans)], first_failure: null,
})
const mount = (t: Trace) => {
  const c = document.createElement('div')
  document.body.appendChild(c)
  root = createRoot(c)
  act(() => root!.render(<MemoryRouter><TraceView t={t} /></MemoryRouter>))
  return c
}

describe('spanCategory', () => {
  it('reads the session-trajectory intent; no intent is "unlabeled", an unknown one "other"', () => {
    expect(spanCategory({ intent: 'git-read' })).toBe('git-read')
    expect(spanCategory({ intent: 'pr-write/merge' })).toBe('pr-write/merge')
    expect(spanCategory({ intent: null })).toBe('unlabeled')
    expect(spanCategory({ intent: 'needs-model' })).toBe('unlabeled')
    expect(spanCategory({ intent: 'test-run' })).toBe('other')
  })
  it('has plain words and a color for every intent of INTENT_LIST_VERSION 2', () => {
    expect(INTENTS).toHaveLength(27)
    for (const c of [...INTENTS, 'unlabeled' as const]) {
      expect(CATEGORY_LABEL[c]).toBeTruthy()
      expect(themeCss).toContain(`--stu-c-${categoryKey(c)}:`)
      expect(tracesCss).toContain(`.trc-bar--c-${categoryKey(c)} {`)
    }
    expect(CATEGORY_LABEL['plan-mcp']).toBe('plan MCP')
    expect(CATEGORY_LABEL['pr-read']).toBe('PR read')
  })
})

describe('commandSummary', () => {
  it('gives the commands of the shape and the short repo name, never the cd prefix', () => {
    expect(commandSummary({ ...REPO, shape: 'git status + git log + ls', preview: 'cd /root/repos/dfl-mcp-server; git status | head -5' })).toBe('git status + git log + ls · dfl-mcp-server')
    expect(commandSummary({ ...REPO, shape: 'gh pr list + cat + grep', preview: null })).toBe('gh pr list + cat + grep · dfl-mcp-server')
    expect(commandSummary({ target_kind: 'skill', target: 'plan-tasks', shape: 'bash <skill:plan-tasks>/run.sh + cat', preview: null })).toBe('bash plan-tasks/run.sh + cat')
    expect(commandSummary({ target_kind: null, target: null, shape: 'npm run build + npx tsc 2>&1 + npx vitest run', preview: null })).toBe('npm run build + npx tsc + npx vitest run')
    expect(commandSummary({ ...REPO, shape: 'cat > <file> + python3 <inline> + git diff', preview: null })).toBe('cat > file + python3 + git diff · dfl-mcp-server')
    expect(commandSummary({ ...REPO, shape: 'which + cat + null', preview: null })).toBe('which + cat · dfl-mcp-server')
  })
  it('with no shape, takes the first command after the cd / export / assignment prefix', () => {
    expect(commandSummary({ ...REPO, shape: null, preview: 'cd /root/repos/dfl-mcp-server && export X=1; gh pr list --repo devfellowship/dfl-mcp-server' })).toBe('gh pr list · dfl-mcp-server')
    expect(commandSummary({ target_kind: null, target: null, shape: null, preview: 'W=/tmp/x cd /a; sed -n 1,20p f' })).toBe('sed')
    expect(commandSummary({ target_kind: null, target: null, shape: null, preview: null })).toBe('—')
  })
})

describe('stepLabel', () => {
  it('labels a shell step by its category, and any other tool by its name', () => {
    expect(stepLabel(span(10, { ...REPO, shape: 'git status + git log + ls', intent: 'git-read' }))).toEqual({ label: 'git read', summary: 'git status + git log + ls · dfl-mcp-server', category: 'git-read' })
    expect(stepLabel(span(17, { ...REPO, shape: 'gh pr list + cat + grep', intent: 'pr-read' })).label).toBe('PR read')
    expect(stepLabel(span(3, { ...REPO, shape: 'ls + grep', intent: null })).label).toBe('unlabeled')
    expect(stepLabel(span(2, { tool: 'mcp__dfl__get_plan', family: 'mcp', intent: 'mcp-read', target_kind: 'mcp', target: 'mcp__dfl__get_plan' }))).toEqual({ label: 'mcp: dfl-get_plan', summary: 'mcp__dfl__get_plan', category: 'mcp-read' })
  })
})

describe('categoryLegend', () => {
  it('lists the categories of the trace, most calls first', () => {
    const l = categoryLegend([{ intent: 'search' }, { intent: 'git-read' }, { intent: 'search' }, { intent: null }, { intent: 'file-read' }])
    expect(l.map((x) => [x.label, x.calls])).toEqual([['search', 2], ['file read', 1], ['git read', 1], ['unlabeled', 1]])
  })
  it('puts the category on each waterfall step', () => {
    const wf = buildWaterfall([run([span(0, { intent: 'build/test' }), span(1, { tool: 'Read', family: 'builtin', intent: 'file-read' })])])
    expect(wf.rows.filter((r) => r.type === 'step').map((r) => r.type === 'step' && r.category)).toEqual(['build/test', 'file-read'])
  })
})

describe('S3 waterfall rows (the example trace d787b418, run af9f6e21)', () => {
  const spans = [
    span(9, { target_kind: 'repo', target: 'devfellowship/dfl-schema', shape: 'sed + grep', intent: 'search' }),
    span(10, { ...REPO, shape: 'git status + git log + ls', intent: 'git-read', preview: 'cd /root/repos/dfl-mcp-server; git status | head -5; git log --oneline | head -3' }),
    span(11, { tool: 'mcp__dfl__get_my_roles', family: 'mcp', intent: 'mcp-read', target_kind: 'mcp', target: 'mcp__dfl__get_my_roles' }),
    span(17, { ...REPO, shape: 'gh pr list + cat + grep', intent: 'pr-read', ok: false }),
  ]
  it('a Bash row shows its category and command, not the repo name alone', () => {
    const c = mount(trace(spans))
    const rows = [...c.querySelectorAll<HTMLElement>('[data-trace-step]')]
    const row10 = rows[1]!
    expect(row10.querySelector('.trc-wf__tool')!.textContent).toBe('git read')
    expect(row10.querySelector('.trc-wf__target')!.textContent).toBe('git status + git log + ls · dfl-mcp-server')
    expect(row10.getAttribute('data-step-category')).toBe('git-read')
    expect(row10.querySelector('.trc-bar')!.className).toContain('trc-bar--c-git-read')
    expect(rows.map((r) => r.querySelector('.trc-wf__tool')!.textContent)).toEqual(['search', 'git read', 'mcp: dfl-get_my_roles', 'PR read'])
    // A failed step stays red, whatever its category.
    expect(rows[3]!.querySelector('.trc-bar')!.className).toBe('trc-bar trc-bar--err')
  })
  it('the legend names the categories of this trace, with their counts, and "failed"', () => {
    const c = mount(trace(spans))
    const items = [...c.querySelectorAll<HTMLElement>('[data-testid="trace-legend"] [data-legend-category]')]
    expect(items.map((i) => i.getAttribute('data-legend-category'))).toEqual(['git-read', 'mcp-read', 'pr-read', 'search', 'failed'])
    expect(items[0]!.textContent).toBe('git read 1')
    expect(items[0]!.querySelector('.trc-swatch')!.className).toContain('trc-bar--c-git-read')
  })
})
