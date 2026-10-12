import { CodePanel } from '../../tma/ui'
import type { Validation } from './useGithubSource'

const MAX_LINES = 12

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Right-column card "Agent files" (ADR-4): the real file set found at the agent path, replacing the tma.agent.yaml card. */
export function AgentFilesPanel({ validation, path }: { validation: Validation; path: string }) {
  if (validation.phase === 'ok') {
    const files = validation.result.files
    const total = validation.result.totalBytes ?? files.reduce((s, f) => s + f.bytes, 0)
    const shown = files.slice(0, MAX_LINES)
    return (
      <div data-testid="agent-files">
        <CodePanel title="Agent files" meta={`${files.length} ${files.length === 1 ? 'file' : 'files'} · ${formatBytes(total)}`} kind="yaml">
          <span className="ta-files">
            {shown.map((f) => (
              <span className="ta-file" key={f.path}>
                <span>{f.path}</span>
                <span>{formatBytes(f.bytes)}</span>
              </span>
            ))}
            {files.length > shown.length && <span className="tma-subtle">+ {files.length - shown.length} more</span>}
          </span>
        </CodePanel>
      </div>
    )
  }
  const text =
    validation.phase === 'running'
      ? 'Reading files…'
      : validation.phase === 'idle'
        ? 'The files found at the agent path show here.'
        : `No agent files read at ${path === '.' ? 'the repo root' : path}.`
  return (
    <div data-testid="agent-files">
      <CodePanel title="Agent files" kind="yaml">
        <span className="ta-files__empty">{text}</span>
      </CodePanel>
    </div>
  )
}
