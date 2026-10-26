# @itera/runner — sandboxed agent runner

The runner executes ONE agent on ONE benchmark scenario, records each tool call, takes the patch, and grades the patch with `services/evaluator`.

## Step 1: the local CLI (`tma`)

`tma` runs the same sandbox, gateway and grader as the hosted worker on your machine, with YOUR model key. Only numbers leave the machine: `result.json` is `tma-local-result/1` (no actions, no patch, no stdout, no key). Send it with `tma upload`.

```bash
cd services/runner
npx tsx src/cli/tma.ts tasks                          # the curated tasks of this runner, offline
npx tsx src/cli/tma.ts workspace --task webhook-ledger --dest ./ws      # public workspace + INSTRUCTION.md, no Docker
# ... edit ./ws with your own harness, then:
npx tsx src/cli/tma.ts grade --task webhook-ledger --workspace ./ws --agent <agent id> --model qwen/qwen3-coder --wall-s 120 --cost-usd 0.05 --out result.json
# or let opencode do it in the sandbox:
docker build -t itera-runner-sandbox:latest sandbox                      # once; or set ITERA_SANDBOX_IMAGE
export OPENROUTER_API_KEY=...                                            # YOUR key (OPENCODE_GO_API_KEY for opencode-go/<model>)
npx tsx src/cli/tma.ts run --task webhook-ledger --agent <agent id> --agent-dir examples/sample-agent --model qwen/qwen3-coder --repeat 3 --out result.json
```

`--task-dir <folder>` selects a private task folder on your disk instead (it never leaves the machine; only its digests go into the result). `grade` and `run` need Docker. MCP tasks run hosted only. The patch, the actions and the evidence manifest go to `./tma-runs/<run-id>/`, for you only. `src/run-once.ts` is an alias of `tma run` (`--scenario` works as `--task`).

## What one run does

1. **Workspace (trusted side).** The runner reads the task contract (`benchmarks/<scenario>/task.json`, or any task bundle, see `services/evaluator/README.md`) and copies ONLY its `environment/` plus the public tests (`tests/public/`) to a temp dir. It does not copy the monorepo, the evaluator, the hidden tests or `solution/`. It copies the agent's `AGENTS.md`, `CLAUDE.md` and `skills/` (to `.opencode/skills/`, where opencode finds project skills). Nothing else from the agent directory goes in. It runs `npm ci --ignore-scripts`, so the agent can run the public tests without network. A baseline git commit records the start state.
2. **Sandbox.** The runner creates a new container from `sandbox/Dockerfile` and a new `--internal` Docker network for this run. It copies the workspace in with `docker cp` (no bind mount, no Docker socket). The container runs `opencode run --pure --format json -m openrouter/<model> "<the task instruction.md>"`.
3. **Trace.** opencode writes one JSON event per line. Each `tool_use` event becomes one action: `seq`, `tool`, `target` (file path relative to the workspace, shell command, or pattern; max 300 characters), `ok`, `occurredAt`.
4. **Patch.** The runner copies the tree back, drops the agent's `.git` and `node_modules`, and diffs the tree against ITS OWN baseline repository. The runner never runs git with the agent's `.git`: a planted hook, `core.fsmonitor` or filter could run commands on the worker.
5. **Grade (in grading containers, see "Grader sandbox").** The evaluator orchestrates on the trusted side: it installs the lockfile with `npm ci --ignore-scripts` and a scrubbed environment, applies the patch with git, checks the scope against `editable_paths` / `protected_paths`, and computes the score. Only the verifier command of `task.json` runs in a container, a fresh one per suite.

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
| Grading integrity against a hostile patch | **Partly** | See "Grader sandbox" below: the scope verdict and the score are computed outside the container, the test files and the test framework are read-only, and the report is cross-checked with the exit code. The patched code still runs in the same process as the tests. |
| Sandbox escape through a kernel or runtime bug | **No** | This is a plain `runc` container. gVisor or a VM would be stronger. |

## Grader sandbox (ADR-9) — what is enforced and what is not

Grading executes code that the agent wrote (`src/**`) and, for a user task, tests that a user wrote. `src/grade.ts` runs each verifier suite (`public-baseline`, `public-after-patch`, `hidden`) in its OWN new container from the sandbox image. Nothing carries over from one suite to the next. Proven by `src/grade.integration.test.ts` (CI, real Docker) with the probe task `test-tasks/escape-probe`, whose five hidden tests try each forbidden action: all five fail.

| Control | Enforced | How |
|---|---|---|
| No network | Yes | `--network none`. Probe: `fetch('http://1.1.1.1/')` fails. |
| No Docker socket, no host path | Yes | Only two anonymous volumes (`/workspace`, `/out`), filled with `docker cp`. Probe: `/var/run/docker.sock` does not exist. |
| No worker environment | Yes | `docker create` gets only `HOME=/tmp CI=1 NPM_CONFIG_OFFLINE=true NPM_CONFIG_UPDATE_NOTIFIER=false`. Probe: `DATABASE_URL` is empty although the worker has it. The trusted-side `npm ci` and git also run with a scrubbed environment, and a bundle with `.npmrc`/`.yarnrc` is refused (a `.npmrc` can expand `${VAR}` into a registry request). |
| Read-only root filesystem | Yes | `--read-only`, `--tmpfs /tmp` (256 MB). |
| User | Yes | uid 10002: not root and not the agent's uid 10001. `--cap-drop ALL`, `no-new-privileges`. |
| Tests, config and test framework not writable | Yes | The workspace is root-owned, mode `go-w`. Only the top directory (sticky, vite writes its bundled config there) and `node_modules/.vite` (sticky, vitest cache) accept new files. Probe: writing `node_modules/vitest/package.json` and planting a file in `tests/hidden/` both fail. |
| Hidden tests only after the patch is frozen | Yes | They exist only in the `hidden` container; the agent sandbox never has them. |
| Scope verdict and score outside the container | Yes | The patch is applied with git on the worker (`--no-renames`: a rename out of `tests/` counts; a symlink in the patch is a violation). The container only returns a report. |
| Resource limits | Yes | `--memory` = `--memory-swap` (min of task `memory_mb` and `ITERA_SANDBOX_MEMORY`), `--cpus` (min of task `cpus` and `ITERA_SANDBOX_CPUS`), `--pids-limit`, `--ulimit nofile=1024`, `--ulimit fsize=256 MB`, wall limit = task `verifier.timeout_sec` then `docker kill`. |
| Report not forgeable to a full pass | **Partly** | The report file is written by the vitest process, which is the same uid as the patched code, so the patched code CAN overwrite it. The evaluator trusts a report only when it agrees with the verifier exit code (vitest exits 0 if and only if no test failed); a disagreement is `report_mismatch` → error → no score. A forged full pass therefore also needs exit code 0. A forged partial count on a failing suite is still possible. |
| Patched code tampering with the test framework in memory | **No** | The patched module is imported by the tests, in the same process. It can monkey-patch `expect` and make assertions pass. This is true of every in-process JS verifier (Harbor and SWE-bench share it). The manifest lists it under `limitations`. |
| Pinned environment | Yes | Install = `npm ci` from the lockfile (lockfile `resolved` URLs must be on `registry.npmjs.org`). The manifest records `environment` (image name + image Id, install argv, lockfile sha256), `environment_digest` (sha256 of it), `evaluator_digest` (sha256 of the evaluator sources) and `evaluator_commit` (`ITERA_GIT_COMMIT`, null when the deployment does not set it). |
| Kernel or runtime escape | **No** | Plain `runc`. gVisor or a VM would be stronger. |

**Validation gate for user tasks.** `validateTaskInSandbox` (services/evaluator `validateTask` with the sandbox executor) checks: (i) on the untouched environment at least one hidden case FAILS; (ii) with `solution/` applied the patch is in scope and every public and hidden case PASSES; (iii) (ii) gives the same result 3 times; (iv) every verifier run ends inside `verifier.timeout_sec`. The result has counts only, never test names.

## Step 2: the worker (`src/worker.ts`)

The worker runs the shared-contract job protocol:

1. **Claim.** `UPDATE runs SET status='running', phase='preparing', claimed_at=now(), worker_id=$1 WHERE id = (SELECT id FROM runs WHERE status='queued' ORDER BY started_at FOR UPDATE SKIP LOCKED LIMIT 1)`. `ITERA_RUNNER_CONCURRENCY` slots (default 2).
2. **Load.** `agent_versions.files` (lane C snapshot) and `agents.model`. Only `AGENTS.md`, `CLAUDE.md` and `skills/**` are written; other paths are skipped; the total is capped at 512 KB.
3. **Model key.** ITERA pays the model tokens (Tainan TG 20967): a run without its own key uses ITERA's platform key `ITERA_RUNNER_OPENROUTER_KEY`. BYOK stays possible: when `POST /runs` gets `modelApiKey`, the API seals it into `runs.model_api_key_enc` (AES-256-GCM, key = HKDF-SHA256 of `ITERA_RUN_KEY_SECRET`) and the worker uses that key instead. A sealed key that does not open is `infra_error` — never a silent switch to the platform key. Either key goes only into the run's gateway container. The finish transaction and the reaper set `model_api_key_enc` to NULL.
4. **Phases.** `agent_running` → `grading` → `done`.
5. **Finish (one transaction).** `status`, `evidence_manifest` (the evaluator manifest plus a `runner` block: model, tool-call count, tokens, cost, wall time), `model_cost_usd` / `model_tokens_in` / `model_tokens_out` (the gateway's measure, from OpenRouter accounting; `db/migrations/0006_run_cost.sql`), `score_total`, `completed_at`, an `observations` row (`mode='observed'`, `output_artifact_ref='patch.diff'`, the patch as content) and the `run_actions` rows.
6. **Status.** wall limit → `timeout`; empty patch → `fail`; out-of-scope patch → `invalid`; **a suite that executed 0 tests (public baseline, public after patch, or hidden) → `infra_error` with score 0** (the evaluator falls back to an empty suite when the vitest report does not parse, so 0 tests means "not measured"); grader failure or evaluator errors → `infra_error`; else `pass` when the score is above 0, `fail` otherwise.
7. **Recovery and redeploys.** On SIGTERM the worker stops claiming and waits up to `ITERA_RUNNER_DRAIN_MS` (420 s, below the 480 s grace period of step 8) for in-flight runs, then exits. At boot it checks liveness by worker: a worker is live when its host (the part of `worker_id` after `@`, the worker container's short id) is a running container. A run left `running` by a dead worker is requeued once as a free retry (`error = 'requeued after a runner restart'`); a second loss is `infra_error`. Sandbox, gateway and grader containers and run networks are removed only when their run (the uuid in the name) is not `running` or its worker is not live, so a booting worker never touches the runs of a draining one (`src/orphans.ts`). Every minute the worker also reaps runs claimed more than `ITERA_RUNNER_STALE_MS` (15 min) ago.

8. **Deploys must drain, not overlap.** The boot recovery in step 7 no longer needs the previous replica to be gone (it spares the runs of a live worker), but stop-first keeps two workers from running at the same time. The Dokploy app `itera-agent-credentials-runner` therefore runs with swarm update order **`stop-first`** and a **stop grace period of 480 s** (Dokploy fields `updateConfigSwarm.Order` and `stopGracePeriodSwarm = 480000000000` ns; set 2026-10-12). On `SIGTERM` the worker stops claiming and waits for its in-flight runs (wall 300 s + grading), then exits; only then does the new replica boot. With the Dokploy defaults (`start-first`, 10 s grace) every deploy killed the in-flight run: on 2026-10-12 the new replica's `removeOrphans()` deleted the old replica's sandbox mid-run (`copy-out failed: RWLayer ... unexpectedly nil` → `infra_error`, run `3a53b90c`). A deploy now takes up to 8 extra minutes when a run is in flight. Check: `docker service inspect <svc> --format '{{.Spec.UpdateConfig.Order}} {{.Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}'` → `stop-first 8m0s`.

The worker image (`services/runner/Dockerfile`, context = repo root) is Debian (glibc), like the sandbox image: the `node_modules` that the worker installs run inside the sandbox, and musl-built native packages (rollup, esbuild) do not load there. It holds `benchmarks/`, `services/evaluator`, this package, git, GNU tar and a static Docker CLI. It needs the host Docker socket. At boot it builds the sandbox image from `services/runner/sandbox/` with a content-hash tag, so a change there takes effect on the next deploy.

## Model routes (K10): OpenRouter or opencode go

The agent's model id picks the route of the run (`src/model-route.ts`):

| Model id | Route | Gateway upstream + path | Key (gateway only) | Cost |
|---|---|---|---|---|
| `opencode-go/<model>` (e.g. `opencode-go/deepseek-v4.1-flash`) | `opencode-go` | `https://opencode.ai` `/zen/go/v1/` (`ITERA_OPENCODE_GO_UPSTREAM`) | `OPENCODE_GO_API_KEY` (ITERA's subscription; a BYOK key is refused) | **derived**: tokens × the price table in `model-route.ts` |
| anything else | `openrouter` | `https://openrouter.ai` `/api/v1/` (`ITERA_MODEL_UPSTREAM`) | BYOK, else `ITERA_RUNNER_OPENROUTER_KEY` | **metered**: OpenRouter's own `usage.cost` |

- The sandbox's opencode uses its built-in `opencode-go` provider, pointed at the gateway by `sandbox/opencode.json` (`http://itera-gateway:3128/zen/go/v1`, placeholder key). The sandbox still holds no key.
- opencode go refuses a request without `x-opencode-session` (`MissingSessionID`). The gateway forwards the `x-opencode-*` headers that opencode sends and adds `x-opencode-session: itera-<run id>` when there is none.
- opencode go answers `usage` with tokens (and `prompt_tokens_details.cached_tokens`) but no USD. The gateway gets the model's price (`ITERA_PRICE_JSON`) and the meter computes `fresh input × input + cached × cacheRead + output × output`. The per-run cap (`ITERA_RUN_MAX_COST_USD`) applies to the derived cost too. A model without a price runs with cost 0 and `cost_source: "unpriced"`.
- `evidence_manifest.runner.route` and `.cost_source` (`metered` | `derived` | `mixed` | `unpriced` | `none`) record which one applied; the report must not mix metered and derived dollars without saying so.

**Benchmark runs without the payment flow.** `npx tsx src/bench-enqueue.ts --task <pack> --model <model id> [--agent-dir examples/bench-agent] [--wait]`, inside the runner container (it uses its `DATABASE_URL`), writes vendor `ITERA benchmark campaign` → agent → agent_version (files digest) → release_declaration → a `queued` run. The live worker runs and grades it like any other run. `examples/bench-agent/AGENTS.md` is the one agent file set of the DFL benchmark campaign.

**Results enter by ONE door: `POST /self-declared-results`.** A result that the hosted worker did not produce (the run happened on the owner's own machine, the task data stays there) is sent to the API with `tma upload` (body `tma-local-result/1`, schema `packages/contracts/schemas/local-result.schema.json`). The API validates the body, authenticates the owner and writes the evaluation and the run in one transaction, marked `result_origin = 'self_declared'`. The runner has no code that writes a result for a user: the operator CLIs `bench-import` and `bench-adopt` (they wrote `public.evaluations` and `public.runs` direct, as the `itera_api_service` role) were deleted (plan `20261026-tma-local-runner-and-self-declared-results`, ADR-3); git history keeps them. `bench-enqueue.ts` stays: it only queues a hosted run, and the worker grades it, so its result is a hosted result. Old `tma-bench-import/*` files go through `tma upload`, which converts them.

**The guard.** `src/result-writes.guard.test.ts` runs with `npm run test` in the `validate` CI job. It fails when (1) a file under `services/runner` other than the worker files writes SQL, or a worker file writes a table that is not on its list; (2) `public.evaluations` or `public.runs` is written outside the API's store layer (`apps/api/src/**/*.pg.ts`, `*store.ts`, `*repository.ts`) and the two worker files `jobs.pg.ts` and `bench-enqueue.ts`; (3) any source file names the `itera_api_service` role; (4) a new file under `services/runner` imports `pg`. A negative test feeds the guard the old `bench-import` insert and the other shapes and requires a violation for each. A new writer is a deliberate act: add it to the lists in the test, in the same PR, with the reason.

## Result provenance, rate limits and campaigns (K11)

**Provenance.** Each finished run records what produced its result (`db/migrations/0017_run_provenance.sql`, `src/provenance.ts`). Typed columns: `model_route`, `model_requested`, `model_effective` (the model id the upstream ANSWERED with), `model_provider` (OpenRouter `provider`, or the opencode go endpoint id), `model_cost_source`, `rate_limited`, `wall_ms`, `timeout_s`. `runs.provenance` (jsonb) holds the full record: agent commit + files, task id/version/contract digest, requested / answered models and providers, the sampling params of the first model call (temperature, max tokens, reasoning — never the messages), run profile and opencode version, runner commit (`ITERA_GIT_COMMIT` / `SOURCE_COMMIT`, else null) and runner source digest, sandbox image tag + Id, MCP image digests and seed digests, grader executor + environment digest, evaluator digest, CPU / memory / pids of the sandbox and each sidecar, and the limits (`timeout_s`, `wall_ms_cap`, measured `wall_ms`, `max_cost_usd`).

**Wall cap per task.** The agent wall cap is the task's `agent.timeout_sec`, capped by `ITERA_RUN_MAX_WALL_MS` (default 900 s). `ITERA_RUN_WALL_MS` is only the fallback when a task has no timeout.

**Upstream 429.** The gateway buffers the request body and retries an upstream `429` with backoff (`Retry-After`, else 2 s, 4 s, 8 s, 16 s; `ITERA_GATEWAY_429_RETRIES`, default 4). A 429 that survives the retries goes back to the agent and is counted as `rate_limited_final`. A run with `rate_limited_final > 0` that did not pass ends **`infra_error`** (unscored, error `upstream rate limit: ...`), never `fail` or `timeout`: the provider stopped the agent, so the run measured nothing about the model. Proven by `src/gateway.integration.test.mjs` (real gateway process, fake upstream).

**Campaign cap.** `bench-enqueue --campaign <id> [--cap-usd 2] [--reserve-usd 0.5]` creates the campaign in `bench_campaigns` on first use and, before each run, checks `spent + (in-flight OpenRouter runs + 1) × reserve ≤ cap` with the campaign row locked (`spent` = metered `model_cost_usd` of its finished OpenRouter runs). When the check fails it records `stopped_at` + `stop_reason` and exits 4; a stopped campaign refuses every later run. The reserve is the per-run cap, so no run can start that could take the campaign past the cap. opencode go runs are tagged with the campaign but spend subscription credit, so they do not count against the OpenRouter cap.

**Disk.** At boot the worker removes the `itera-runner-sandbox:*` tags other than the current one (`docker rmi` keeps a tag still in use).

## Run profile (Valkyrie-shaped)

The per-run configuration is a **run profile**, `profiles/<name>.json`, validated against `packages/contracts/schemas/run-profile.schema.json` (Ajv). Its boundaries and field names follow the Valkyrie agent contract (`vals-ai/Valkyrie` `docs/agents/agent-contract.mdx`, commit `68edd7ac`, AGPL-3.0: names reused, no code copied). `opencode` is the one built-in profile and reproduces the previous hard-coded behaviour byte for byte (`src/run-profile.test.ts`). `ITERA_RUN_PROFILE` selects another built-in profile.

| Valkyrie field | Profile field | opencode value |
|---|---|---|
| `name` | `name` | `opencode` |
| `install_cmd` (shell string) | `install_cmd` (argv, trusted side; npm needs `--ignore-scripts`) | `npm ci --include=dev --no-audit --no-fund --ignore-scripts` |
| `run_cmd` (shell string, `{placeholders}`) | `run_cmd` (argv; `{workspace}` `{model}` `{instruction}`) | `opencode run --pure --format json --dir {workspace} -m {model} {instruction}` |
| `final_output` (path) | `final_output` | `workspace-diff`: the tree is copied out and diffed against the runner's baseline |
| `output_artifacts` | `output_artifacts` | `trace` = stdout, opencode JSON events, optional |
| `install_egress` | `install_egress` | `registry.npmjs.org` |
| — (benchmark run policy; legacy `egress_allowlist`) | `run_egress` (ours) | `model-gateway` only |
| `secrets` (env name → secret store name) | `secrets` (names only; `inject_into` must be `gateway`) | `ITERA_UPSTREAM_KEY` ← the run's model key, gateway only |
| — | `timeouts` (ours) | install 180 s, run 300 s |
| — | `resources` (ours) | 2 cpus, 2048 MB, 512 pids |

The `ITERA_RUN_WALL_MS`, `ITERA_SANDBOX_MEMORY`, `ITERA_SANDBOX_CPUS` and `ITERA_SANDBOX_PIDS` variables below still override the profile. `install_egress` is declarative today: the trusted-side install runs with the worker's network, and the lockfile check of `services/evaluator` (`resolved` URLs on `registry.npmjs.org`) is what holds it to the registry for task bundles.

## User tasks (U19) — read from GitHub at the pinned commit, never stored

A user task version is a GitHub repo + branch + commit + folder (`task_versions`, Gate Q4). The worker
reads that folder through the TestMyAgent GitHub App with an installation token, for every job, into a
temp dir on the trusted side, and deletes it when the job ends (Gate Q5: no copy at rest).

- **Validation gate** — `POST /tasks/:id/versions/:v/validate` queues a `task_validations` row. The
  worker claims it (`FOR UPDATE SKIP LOCKED`, sharing the run slots, runs first), fetches the folder,
  and runs `validateTaskInSandbox` (baseline: hidden tests FAIL; solution: every case PASSES; 3
  identical repeats; every verifier run inside `verifier.timeout_sec`). One transaction then writes
  the result, the digests and `runnable` on the version, a task pack `user-<task_version_id>` / `1`
  when ready, and the task status. A folder that cannot be accepted (symlink, submodule, no
  `task.json`, above 1000 files / 5 MB) is `invalid`; GitHub or Docker failing is `error` (not judged).
- **Runs** — a run whose pack id starts with `user-` fetches the folder at the same commit, checks
  that the environment and hidden-test digests equal the ones the gate pinned, then runs the agent
  and grades exactly as for a curated task (`taskDir`). The agent workspace still holds only
  `environment/` + the public tests (`src/user-tasks.test.ts` proves no hidden-test file or byte
  reaches it).

## Configuration (env)

| Variable | Default | Use |
|---|---|---|
| `DATABASE_URL` | — | Worker: same value as the API app. TLS with the pinned pooler CA (`apps/api/certs`). |
| `ITERA_RUN_KEY_SECRET` | — | Worker and API: opens / seals the BYOK key. At least 32 characters. Optional when only platform-key runs are used. |
| `ITERA_RUNNER_OPENROUTER_KEY` | — | ITERA's platform OpenRouter key (worker only). Used for every run without a BYOK key. Kept in the secret store of the deployment. The `tma` CLI never reads it. |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | — | User tasks (U19): read the task folder through the GitHub App. Same values as the API. Without them a user-task validation ends `error` and a user-task run `infra_error`. |
| `ITERA_USER_TASKS` | on | `off` disables the validation queue on this worker. |
| `ITERA_RUN_MAX_COST_USD` | `0.50` | Hard model-cost cap of one run, enforced by the gateway. |
| `ITERA_RUNNER_CONCURRENCY` / `ITERA_RUNNER_POLL_MS` / `ITERA_RUNNER_STALE_MS` | `2` / `3000` / `900000` | Worker loop. |
| `ITERA_RUNNER_HEARTBEAT_MS` | `30000` | Interval of the `runner_heartbeats` upsert (0020). The API `GET /health` reads it as `runnerSeenAt`. A failed write or a missing table never stops the worker. |
| `ITERA_SANDBOX_IMAGE` | worker: built at boot; CLI: `itera-runner-sandbox:latest` | Image built from `sandbox/`. |
| `ITERA_MODEL_UPSTREAM` | `https://openrouter.ai` | Gateway upstream of the `openrouter` route. |
| `OPENCODE_GO_API_KEY` | — | ITERA's opencode go key (K10). Runs with an `opencode-go/<model>` agent need it; without it they end `infra_error`. Kept in the secret store of the deployment. |
| `ITERA_OPENCODE_GO_UPSTREAM` | `https://opencode.ai` | Gateway upstream of the `opencode-go` route. |
| `ITERA_RUN_WALL_MS` | `300000` | Agent wall limit when the task declares no `agent.timeout_sec`. |
| `ITERA_RUN_MAX_WALL_MS` | `900000` | Upper bound of the per-task agent wall limit (K11). |
| `ITERA_GATEWAY_429_RETRIES` | `4` | Upstream 429 retries in the run gateway (K11). |
| `ITERA_SANDBOX_MEMORY` / `ITERA_SANDBOX_CPUS` / `ITERA_SANDBOX_PIDS` | `2g` / `2` / `512` | Sandbox limits. |

## MCP sidecars (U29, ADR-11)

A task that declares `environment.tools.mcp[]` gets one sidecar per server, per run (`src/mcp-sidecar.ts`; design in `docs/architecture/mcp-sandbox.md`):

- `catalog: name@version` resolves to a **published** row of `mcp_catalog` (0013) and runs as `image@digest`. A custom `image`/`command` is refused (review flow not built).
- The sidecar joins only the run's `--internal` network (alias `mcp-<name>`), with a fresh 32-byte token, `ITERA_MCP_ALLOWED_TOOLS`, a fixed clock, read-only rootfs, state in a tmpfs, `cap-drop ALL`, and limits from the manifest capped by `ITERA_MCP_MAX_CPUS` / `ITERA_MCP_MAX_MEMORY_MB` / `ITERA_MCP_MAX_PIDS`. The seed goes in with `docker cp`.
- Readiness: `tools/list` through the token must equal the pinned snapshot, before the agent starts.
- The agent's opencode config gets one `remote` MCP entry per server and switches off the built-in tools the task does not allow (`OPENCODE_BUILTIN_TOOLS`). The server enforces `allowed_tools`; the config is a convenience.
- After the agent: `docker exec /itera/export` (final state) + `docker logs` (call log), then removal. The worker scores the state against `tests/hidden/mcp/<name>/assert.json` (`mcp_state`, weight 50; code scorers take the other 50). Only digests and counts reach the EvalLog. MCP calls are `run_actions` rows with tool `<server>_<tool>`.
- Validation gate `mcp` step (`src/mcp-gate.ts`): assertions FAIL with no calls; the replay of `solution/mcp-calls.jsonl` makes them PASS 3× with the same export sha256.
- Curated packs: the worker registers every `benchmarks/*` bundle in `task_packs` at boot (`src/curated-packs.ts`).
