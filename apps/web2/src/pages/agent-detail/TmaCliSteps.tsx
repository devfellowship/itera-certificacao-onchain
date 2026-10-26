/**
 * The next step after a local agent exists: the `tma` CLI commands (services/runner/src/cli, plan L6/L7).
 * The command names and flags are the real ones of `tma <command> --help`; nothing here is invented.
 */
import type { Agent } from '../../lib/api'

export function TmaCliSteps({ agent }: { agent: Pick<Agent, 'id' | 'model'> }) {
  const model = agent.model ?? '<model id>'
  return (
    <div className="lav-cli" data-testid="tma-cli-steps">
      <ol className="lav-cli__steps">
        <li>
          <span>Sign in once. The command opens the browser.</span>
          <pre className="lav-cli__code">tma login</pre>
        </li>
        <li>
          <span>
            Run a task with your own key. Pick a slug from <code>tma tasks</code>. The result file holds numbers only.
          </span>
          <pre className="lav-cli__code">{`export OPENROUTER_API_KEY=...\ntma run --task <task slug> --agent ${agent.id} --agent-dir ./my-agent --model ${model} --out result.json`}</pre>
        </li>
        <li>
          <span>Send the result. It appears here as self-declared, visible only to you.</span>
          <pre className="lav-cli__code">tma upload result.json</pre>
        </li>
      </ol>
      <span className="lav-cli__hint">
        <code>tma</code> lives in <code>services/runner</code> of the itera-certificacao-onchain repo: <code>npm run tma -- &lt;command&gt;</code>. <code>tma run</code> needs Docker.
      </span>
    </div>
  )
}
