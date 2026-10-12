# @itera/runner — sandboxed agent runner

The runner executes ONE agent on ONE benchmark scenario, records each tool call, takes the patch, and grades the patch with `services/evaluator`.

## Step 1: local CLI

```bash
docker build -t itera-runner-sandbox:latest services/runner/sandbox   # on the DFL host: safe-docker-build
export OPENROUTER_API_KEY=...                                          # or ITERA_RUNNER_OPENROUTER_KEY
npx tsx services/runner/src/run-once.ts \
  --scenario webhook-ledger \
  --agent-dir services/runner/examples/sample-agent \
  --model qwen/qwen3-coder \
  --out result.json
```

`result.json` holds `actions` (the future `run_actions` rows), `usage` (tokens and cost), `patch` (unified diff) and `manifest` (the evaluator evidence manifest with the score).

## What one run does

1. **Workspace (trusted side).** The runner copies ONLY `benchmarks/<scenario>/fixture` to a temp dir. It does not copy the monorepo, the evaluator or the hidden tests. It copies the agent's `AGENTS.md`, `CLAUDE.md` and `skills/` (to `.opencode/skills/`, where opencode finds project skills). Nothing else from the agent directory goes in. It runs `npm ci --ignore-scripts`, so the agent can run the public tests without network. A baseline git commit records the start state.
2. **Sandbox.** The runner creates a new container from `sandbox/Dockerfile` and a new `--internal` Docker network for this run. It copies the workspace in with `docker cp` (no bind mount, no Docker socket). The container runs `opencode run --pure --format json -m openrouter/<model> "<scenario agent_prompt>"`.
3. **Trace.** opencode writes one JSON event per line. Each `tool_use` event becomes one action: `seq`, `tool`, `target` (file path relative to the workspace, shell command, or pattern; max 300 characters), `ok`, `occurredAt`.
4. **Patch.** The runner copies the tree back, drops the agent's `.git` and `node_modules`, and diffs the tree against ITS OWN baseline repository. The runner never runs git with the agent's `.git`: a planted hook, `core.fsmonitor` or filter could run commands on the worker.
5. **Grade.** `runEvaluation()` from `services/evaluator` applies the patch to a fresh fixture, then runs the public and the hidden tests.

## Sandbox — what is enforced and what is not

| Control | Enforced | How |
|---|---|---|
| No Docker socket, no host mounts | Yes | `docker create` has no `-v`/`--mount`; files go in and out with `docker cp`. |
| No secret in the sandbox | Yes | The sandbox gets no environment secret. The model key lives only in the **model gateway** container, which adds the `Authorization` header to each upstream request. The sandbox config uses the placeholder key `sandbox-has-no-key`. |
| No direct internet | Yes | Each run has its own `docker network create --internal` network: no gateway, no NAT. Measured: `https://example.com`, `https://1.1.1.1` and `https://openrouter.ai` all time out from the sandbox. |
| Only the model API is reachable | Yes | The only other container on the run network is the gateway (`sandbox/model-gateway.mjs`). It forwards plain-HTTP requests under `/api/v1/` to `https://openrouter.ai` and answers `403` to every other path and to every `CONNECT` tunnel. |
| Runs cannot reach each other | Yes | One network per run. The gateway joins it for the run and leaves after. |
| Privileges and resources | Yes | `--cap-drop ALL`, `no-new-privileges`, non-root uid 10001, `--memory 2g` (no swap), `--cpus 2`, `--pids-limit 512`. |
| Wall limit | Yes | 300 s (`ITERA_RUN_WALL_MS`), then `docker kill`. The partial tree is still diffed and graded. |
| Which model the agent calls | **No** | The gateway forwards any `/api/v1/` call. The agent can call another OpenRouter model, or more tokens than needed, inside the 300 s. Limit the cost with a credit limit on the OpenRouter key. |
| What the agent sends to the model | **No** | The workspace content goes to the model provider. The workspace holds only the public fixture and the agent's own files. |
| Reading the key's metadata | **No** | `GET /api/v1/key` answers with the key's label and usage, not the key value. |
| Sandbox escape through a kernel or runtime bug | **No** | This is a plain `runc` container. gVisor or a VM would be stronger. |

## Configuration (env)

| Variable | Default | Use |
|---|---|---|
| `ITERA_RUNNER_OPENROUTER_KEY` / `OPENROUTER_API_KEY` | — | Model key. Only the gateway receives it. |
| `ITERA_SANDBOX_IMAGE` | `itera-runner-sandbox:latest` | Image built from `sandbox/`. |
| `ITERA_GATEWAY_CONTAINER` | `itera-runner-gateway` | Name of the long-lived gateway container. It is recreated when the key changes (label `itera.key-fp`, a 12-hex sha256 prefix). |
| `ITERA_MODEL_UPSTREAM` | `https://openrouter.ai` | Gateway upstream. |
| `ITERA_RUN_WALL_MS` | `300000` | Agent wall limit. |
| `ITERA_SANDBOX_MEMORY` / `ITERA_SANDBOX_CPUS` / `ITERA_SANDBOX_PIDS` | `2g` / `2` / `512` | Sandbox limits. |
