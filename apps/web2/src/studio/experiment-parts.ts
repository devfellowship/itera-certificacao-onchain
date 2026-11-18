/**
 * The part table of S5 (plan 20261112-tma-c5-studio-area-web2, task C5-RD-S5; canvas artboard "AgentVariant").
 * A variant is the base agent plus ONE change (parent ADR-26): `change_kind` names the part that changed, and
 * `variant_sha256` is the digest of that one diff. The server keeps digests only, so a base cell shows what the agent
 * version holds (harness, model, or a digest) and the variant cell says "same" or names the change. The diff text
 * stays on the user's host.
 */
import type { EvalAgentVersion } from '../lib/api/types'
import { sha12 } from './runs'

export interface PartRow {
  key: string
  label: string
  /** The rows under the "Tools & permissions" heading (the agent's own, not the environment). */
  group: 'agent' | 'tools'
  /** What the base agent version holds for this part; null = the version does not record it. */
  base: string | null
  /** True when the variant's one change is in this part. */
  changed: boolean
}

/** change_kind (local-result-v3 schema) -> the part row that holds it. */
const PART_OF_CHANGE: Record<string, string> = {
  harness: 'harness',
  model: 'model',
  skill: 'skills',
  orchestration: 'settings',
  limits: 'settings',
  retrieval: 'settings',
  memory: 'settings',
  mcp: 'mcp',
  tools: 'tools',
  permissions: 'permissions',
  rules: 'instructions',
  prompt: 'instructions',
}

export const partOfChange = (changeKind: string): string | null => PART_OF_CHANGE[changeKind] ?? null

const digest = (s: string | null) => (s ? `digest ${sha12(s)}` : null)

/** The rows of the part table, in the artboard order, for a base agent version and a change kind. */
export function partRows(agent: EvalAgentVersion, changeKind: string): PartRow[] {
  const changedPart = partOfChange(changeKind)
  const row = (key: string, label: string, group: PartRow['group'], base: string | null): PartRow => ({ key, label, group, base, changed: key === changedPart })
  const harness = [agent.harness, agent.harnessVersion].filter(Boolean).join(' ')
  return [
    row('harness', 'Harness', 'agent', agent.harnessRepoSha ? `${harness}@${agent.harnessRepoSha.slice(0, 7)}` : harness || null),
    row('model', 'Model', 'agent', agent.modelId || null),
    row('skills', 'Skills', 'agent', digest(agent.skillsSha256)),
    row('settings', 'Settings', 'agent', null),
    row('mcp', 'MCP servers', 'tools', digest(agent.mcpManifestSha256)),
    row('tools', 'Enabled tools', 'tools', digest(agent.toolsSha256)),
    row('permissions', 'Permissions', 'tools', null),
    row('instructions', 'Instructions (rules)', 'agent', digest(agent.rulesSha256)),
  ]
}

/** The words of a change in the variant column ("edited instructions", "other model"). */
export function changeWords(changeKind: string): string {
  if (changeKind === 'model') return 'other model'
  if (changeKind === 'harness') return 'other harness'
  if (changeKind === 'prompt') return 'edited prompt'
  if (changeKind === 'rules') return 'edited rules'
  if (changeKind === 'skill') return 'edited skill'
  if (changeKind === 'none') return 'same'
  return `edited ${changeKind}`
}

/** The runs the commands make: the chosen variant runs every case of the dataset `repeat` times (a trace_review case grades once). */
export function plannedRuns(cases: Array<{ mode: string }>, repeat: number): number {
  return cases.reduce((n, c) => n + (c.mode === 'trace_review' ? 1 : repeat), 0)
}
