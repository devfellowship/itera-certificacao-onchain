/**
 * The `tma` CLI commands of the local runner (services/runner/src/cli, plan L6/L7; moved here from
 * pages/agent-detail in L15b so the LocalRunnerHint can reuse it). The command names and flags are the
 * real ones of `tma <command> --help`; nothing here is invented.
 * Without an agent the steps are generic: `<agent id>` and `<model id>` placeholders.
 */

export interface TmaCliAgent {
  id: string
  model?: string | null
}

export function TmaCliSteps({ agent, taskSlug }: { agent?: TmaCliAgent | null; taskSlug?: string | null }) {
  const model = agent?.model ?? '<model id>'
  const agentId = agent?.id ?? '<agent id>'
  const task = taskSlug || '<task slug>'
  return (
    <div className="tma-cli" data-testid="tma-cli-steps">
      <ol className="tma-cli__steps">
        <li>
          <span>Sign in once. The command opens the browser.</span>
          <pre className="tma-cli__code">tma login</pre>
        </li>
        <li>
          <span>
            Run a task with your own key. Pick a slug from <code>tma tasks</code>. The result file holds numbers only.
          </span>
          <pre className="tma-cli__code" data-testid="tma-cli-run">{`export OPENROUTER_API_KEY=...\ntma run --task ${task} --agent ${agentId} --agent-dir ./my-agent --model ${model} --out result.json`}</pre>
        </li>
        <li>
          <span>Send the result. It appears here as self-declared, visible only to you.</span>
          <pre className="tma-cli__code">tma upload result.json</pre>
        </li>
      </ol>
      <span className="tma-cli__hint">
        <code>tma</code> lives in <code>services/runner</code> of the itera-certificacao-onchain repo: <code>npm run tma -- &lt;command&gt;</code>. <code>tma run</code> needs Docker.
      </span>
    </div>
  )
}
