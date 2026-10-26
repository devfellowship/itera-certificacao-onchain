/** Source of a new agent (L11): the GitHub repository flow (U10, default) or a local agent that runs on the owner's machine. */
import { RadioCard } from '../../tma/ui'

export type AgentSource = 'github' | 'local'

export function SourceChoice({ value, onChange }: { value: AgentSource; onChange: (source: AgentSource) => void }) {
  return (
    <div className="ta-source" role="radiogroup" aria-label="Agent source" data-testid="agent-source-choice">
      <div data-testid="source-github">
        <RadioCard checked={value === 'github'} onSelect={() => onChange('github')} title="GitHub repository" description="TestMyAgent runs it in a sandbox, pinned to a commit. Results are verified." />
      </div>
      <div data-testid="source-local">
        <RadioCard checked={value === 'local'} onSelect={() => onChange('local')} title="Local (runs on my machine)" description="You run it with the tma CLI and upload the numbers. Results are self-declared and visible only to you." />
      </div>
    </div>
  )
}
