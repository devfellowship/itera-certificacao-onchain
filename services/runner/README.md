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
5. **Grade (in a second sandbox container).** The evaluator executes agent-authored `src/**` through vitest, so it never runs in the worker process (root, Docker socket, `DATABASE_URL`). `src/grade.ts` starts a grader container from the sandbox image with `--network none`, no environment secret, no mount, non-root, capabilities dropped. It receives a fresh fixture (dependencies installed on the trusted side with `npm ci --ignore-scripts`), the hidden tests, the evaluator bundled into one file (`services/evaluator/dist/cli.mjs`, esbuild) and the patch. The manifest comes back with `docker cp` and must pass a shape check; anything else is a grader failure, never a score.

## Sandbox — what is enforced and what is not

| Control | Enforced | How |
|---|---|---|
| No Docker socket, no host mounts | Yes | `docker create` has no `-v`/`--mount`; files go in and out with `docker cp`. |
| No secret in the sandbox | Yes | The sandbox gets no environment secret. The model key lives only in the run's **model gateway** container (one per run), which adds the `Authorization` header to each upstream request. The sandbox config uses the placeholder key `sandbox-has-no-key`. |
| No direct internet | Yes | Each run has its own `docker network create --internal` network: no gateway, no NAT. Measured: `https://example.com`, `https://1.1.1.1` and `https://openrouter.ai` all time out from the sandbox. |
| Only the model API is reachable | Yes | The only other container on the run network is the gateway (`sandbox/model-gateway.mjs`). It forwards plain-HTTP requests under `/api/v1/` to `https://openrouter.ai` and answers `403` to every other path and to every `CONNECT` tunnel. |
| Runs cannot reach each other | Yes | One network and one gateway per run, both removed after the run. |
| Privileges and resources | Yes | `--cap-drop ALL`, `no-new-privileges`, non-root uid 10001, `--memory 2g` (no swap), `--cpus 2`, `--pids-limit 512`. |
| Wall limit | Yes | 300 s (`ITERA_RUN_WALL_MS`), then `docker kill`. The partial tree is still diffed and graded. |
| Which model the agent calls | **No** | The gateway forwards any `/api/v1/` call. The agent can call another OpenRouter model inside the 300 s. |
| Model cost per run | Yes (hard cap) | The gateway reads OpenRouter's `usage` (tokens + `cost` in USD) of every response and keeps the run's total. When the total reaches `ITERA_RUN_MAX_COST_USD` (default 0.50), it answers `402` to every further model call; the run ends `timeout` with the error `model cost cap reached: ...`. A call already in flight can finish, so the total can pass the cap by the cost of that one call. |
| What the agent sends to the model | **No** | The workspace content goes to the model provider. The workspace holds only the public fixture and the agent's own files. |
| Reading the key's metadata | **No** | `GET /api/v1/key` answers with the key's label and usage, not the key value. |
| Grading integrity against a hostile patch | **Partly** | The agent's code runs in the same grader container as vitest, so a hostile patch could tamper with the test report or the manifest file. It cannot reach the worker, the network, a secret or the database. A tampered result is still bounded by the patch, which is stored next to it and can be re-graded. |
| Sandbox escape through a kernel or runtime bug | **No** | This is a plain `runc` container. gVisor or a VM would be stronger. |

## Step 2: the worker (`src/worker.ts`)

The worker runs the shared-contract job protocol:

1. **Claim.** `UPDATE runs SET status='running', phase='preparing', claimed_at=now(), worker_id=$1 WHERE id = (SELECT id FROM runs WHERE status='queued' ORDER BY started_at FOR UPDATE SKIP LOCKED LIMIT 1)`. `ITERA_RUNNER_CONCURRENCY` slots (default 2).
2. **Load.** `agent_versions.files` (lane C snapshot) and `agents.model`. Only `AGENTS.md`, `CLAUDE.md` and `skills/**` are written; other paths are skipped; the total is capped at 512 KB.
3. **Model key.** ITERA pays the model tokens (Tainan TG 20967): a run without its own key uses ITERA's platform key `ITERA_RUNNER_OPENROUTER_KEY`. BYOK stays possible: when `POST /runs` gets `modelApiKey`, the API seals it into `runs.model_api_key_enc` (AES-256-GCM, key = HKDF-SHA256 of `ITERA_RUN_KEY_SECRET`) and the worker uses that key instead. A sealed key that does not open is `infra_error` — never a silent switch to the platform key. Either key goes only into the run's gateway container. The finish transaction and the reaper set `model_api_key_enc` to NULL.
4. **Phases.** `agent_running` → `grading` → `done`.
5. **Finish (one transaction).** `status`, `evidence_manifest` (the evaluator manifest plus a `runner` block: model, tool-call count, tokens, cost, wall time), `model_cost_usd` / `model_tokens_in` / `model_tokens_out` (the gateway's measure, from OpenRouter accounting; `db/migrations/0006_run_cost.sql`), `score_total`, `completed_at`, an `observations` row (`mode='observed'`, `output_artifact_ref='patch.diff'`, the patch as content) and the `run_actions` rows.
6. **Status.** wall limit → `timeout`; empty patch → `fail`; out-of-scope patch → `invalid`; **a suite that executed 0 tests (public baseline, public after patch, or hidden) → `infra_error` with score 0** (the evaluator falls back to an empty suite when the vitest report does not parse, so 0 tests means "not measured"); grader failure or evaluator errors → `infra_error`; else `pass` when the score is above 0, `fail` otherwise.
7. **Recovery.** At boot the worker removes orphan sandbox/gateway containers and networks, and marks every `running` run as `infra_error` (one replica; set `ITERA_RUNNER_SINGLETON=false` to turn this off). Every minute it reaps runs claimed more than `ITERA_RUNNER_STALE_MS` (15 min) ago.

8. **Deploys must drain, not overlap.** The boot recovery in step 7 assumes the previous replica is gone. The Dokploy app `itera-agent-credentials-runner` therefore runs with swarm update order **`stop-first`** and a **stop grace period of 480 s** (Dokploy fields `updateConfigSwarm.Order` and `stopGracePeriodSwarm = 480000000000` ns; set 2026-10-12). On `SIGTERM` the worker stops claiming and waits for its in-flight runs (wall 300 s + grading), then exits; only then does the new replica boot. With the Dokploy defaults (`start-first`, 10 s grace) every deploy killed the in-flight run: on 2026-10-12 the new replica's `removeOrphans()` deleted the old replica's sandbox mid-run (`copy-out failed: RWLayer ... unexpectedly nil` → `infra_error`, run `3a53b90c`). A deploy now takes up to 8 extra minutes when a run is in flight. Check: `docker service inspect <svc> --format '{{.Spec.UpdateConfig.Order}} {{.Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}'` → `stop-first 8m0s`.

The worker image (`services/runner/Dockerfile`, context = repo root) is Debian (glibc), like the sandbox image: the `node_modules` that the worker installs run inside the sandbox, and musl-built native packages (rollup, esbuild) do not load there. It holds `benchmarks/`, `services/evaluator`, this package, git, GNU tar and a static Docker CLI. It needs the host Docker socket. At boot it builds the sandbox image from `services/runner/sandbox/` with a content-hash tag, so a change there takes effect on the next deploy.

## Configuration (env)

| Variable | Default | Use |
|---|---|---|
| `DATABASE_URL` | — | Worker: same value as the API app. TLS with the pinned pooler CA (`apps/api/certs`). |
| `ITERA_RUN_KEY_SECRET` | — | Worker and API: opens / seals the BYOK key. At least 32 characters. Optional when only platform-key runs are used. |
| `ITERA_RUNNER_OPENROUTER_KEY` | — | ITERA's platform OpenRouter key (worker, and `run-once.ts`). Used for every run without a BYOK key. Infisical `/apps/itera-agent-credentials/ITERA_RUNNER_OPENROUTER_KEY`. |
| `ITERA_RUN_MAX_COST_USD` | `0.50` | Hard model-cost cap of one run, enforced by the gateway. |
| `ITERA_RUNNER_CONCURRENCY` / `ITERA_RUNNER_POLL_MS` / `ITERA_RUNNER_STALE_MS` | `2` / `3000` / `900000` | Worker loop. |
| `ITERA_SANDBOX_IMAGE` | worker: built at boot; CLI: `itera-runner-sandbox:latest` | Image built from `sandbox/`. |
| `ITERA_MODEL_UPSTREAM` | `https://openrouter.ai` | Gateway upstream. |
| `ITERA_RUN_WALL_MS` | `300000` | Agent wall limit. |
| `ITERA_SANDBOX_MEMORY` / `ITERA_SANDBOX_CPUS` / `ITERA_SANDBOX_PIDS` | `2g` / `2` / `512` | Sandbox limits. |
