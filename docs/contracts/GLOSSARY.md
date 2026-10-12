# Contract glossary — old names → community names

testmyagent reuses the **names, boundaries and contracts** of three community projects. It does
not run their code. Everything is implemented in TypeScript in this repository.

| Source | What we reuse | License | Pinned reference |
|---|---|---|---|
| **Harbor** (`harbor-framework/harbor`) | The task layout and field names: the Task contract | Apache-2.0 | `src/harbor/models/task/config.py`, `paths.py` (task schema 1.4) |
| **Inspect AI** (`UKGovernmentBEIS/inspect_ai`) | The evaluation vocabulary: Task, Sample, Solver, Scorer, Score, EvalLog | MIT | `src/inspect_ai/log/_log.py` (EvalLog v2, EvalSpec, EvalPlan, EvalResults, EvalStats, EvalSample), `scorer/_metric.py` (Score), `dataset/_dataset.py` (Sample), commit `a1dbea8` |
| **Valkyrie** (`vals-ai/Valkyrie`) | The agent-run contract boundaries: install / run / collect / egress / secrets | AGPL-3.0: names only, no code copied | `docs/agents/agent-contract.mdx`, commit `68edd7a` |

## Rule kept from Inspect: the trusted plane

The Scorer never runs in the agent sandbox. The agent (Solver) runs in its sandbox container. The
verifier command runs in separate grading containers (one per suite). The Scorers run on the
worker, outside every container (`services/runner/README.md`, "Grader sandbox").

## Inspect AI vocabulary

| Inspect name | Meaning in testmyagent | Old name in our code | Where |
|---|---|---|---|
| **Task** | One task version: the `task.json` bundle (Harbor layout) | scenario, task pack, benchmark | `packages/contracts/schemas/task.schema.json`, `services/evaluator/src/task.ts` |
| **Dataset** | The samples of a task. Today one sample per task | — | `EvalLog.eval.dataset` |
| **Sample** | One instance of the task. `input` = the instruction (stored as its sha256), `target` = "the hidden tests pass" | — | `EvalLog.samples[0]` |
| **Solver** | The agent under test: the repository files (AGENTS.md, CLAUDE.md, skills/) + the model + the opencode harness | agent run | `services/runner/src/agent-run.ts`, `EvalLog.eval.solver` |
| **SandboxEnvironment** | Where code runs: the agent sandbox, and the grading containers | `SuiteExecutor` | `services/evaluator/src/suite.ts`, `services/runner/src/grade.ts` |
| **Scorer** | One weighted grader: `public_behavior`, `hidden_behavior`, `regression`, `patch_integrity_and_scope`, `reproducible_evidence` | `computeScore` components | `services/evaluator/src/score.ts` (`SCORERS`) |
| **Score** | `{ value, answer, explanation, metadata }`. `value: null` = **unscored**, never a zero | score part (a bare number) | `EvalLog.samples[0].scores` |
| **EvalLog** | The per-run log = the evidence manifest (`runs.evidence_manifest`) | `EvidenceManifest` (kept as a deprecated alias) | `services/evaluator/src/types.ts`, `packages/contracts/schemas/evidence-manifest.schema.json` |
| **EvalSpec** (`eval`) | What was evaluated, pinned: task, task digest, scorers, evaluator digest and commit, environment digest, solver | parts of `contract`, `environment` | `EvalLog.eval` |
| **EvalPlan** (`plan`) | The steps: install → agent → verifier | — | `EvalLog.plan` |
| **EvalResults** (`results`) | Per-scorer metrics of the run | `score` (legacy block, kept) | `EvalLog.results` |
| **EvalStats** (`stats`) | Start time, end time, model usage | `runner.usage` (kept) | `EvalLog.stats` |
| **EvalLog.status** | `success` or `error`: did the evaluation itself complete | — | `EvalLog.status` |

The EvalLog keeps every legacy key (`scenario_id`, `patch_hash`, `patch_scope`, `tests`, `score`,
`errors`, `runner`). The API and the proofs that already exist read them. The Inspect blocks are
added next to them (evaluator `schema_version` 0.3.0).

### Run state is not the verdict (analysis vocabulary)

| Field | Values | Meaning |
|---|---|---|
| `result.state` | `queued`, `running`, `completed`, `timeout`, `infra_error`, `cancelled` | How the run ended (operational) |
| `result.verdict` | `pass`, `fail`, `invalid`, `inconclusive`, `null` (not finished) | What the evidence says about the agent |
| `result.scored` | `true` / `false` | `false` = the score measures nothing (an `infra_error` run) |

`runs.status` stays as it is for backward compatibility. `GET /runs/:id` adds `result` and
`evidence`. The mapping is `runResult()` in `packages/contracts/index.js`.

## Valkyrie agent-contract boundaries → our run profile

The run profile is a JSON Schema plus a TS type in `packages/contracts` (`schemas/run-profile.schema.json`, `validateRunProfile`). `services/runner` reads
the per-run configuration from it. The opencode harness is one built-in profile
(`services/runner/profiles/opencode.json`).

| Valkyrie field | Our field | Note |
|---|---|---|
| `name` | `name` | `opencode` |
| `install_cmd` (string) | `install_cmd` (argv, no shell) | `npm ci --ignore-scripts`, trusted side |
| `run_cmd` (string with `{placeholders}`) | `run_cmd` (argv with `{workspace}`, `{model}`, `{instruction}`) | |
| `final_output` (path) | `final_output: "workspace-diff"` | the workspace tree, diffed against the runner's own baseline into the patch |
| `output_artifacts` | `output_artifacts` | `trace` = the opencode JSON events |
| `install_egress` (`"*"` or hosts) | `install_egress` | `registry.npmjs.org`. **Declared, not enforced by the network**: the install runs on the worker; the lockfile check (registry.npmjs.org only) is what holds it |
| — (the benchmark owns the run policy; legacy `egress_allowlist`) | `run_egress` | our extension: only the per-run model gateway |
| `secrets` | `secrets` (names only) | platform-injected, into the gateway, never into the sandbox |
| — | `timeouts`, `resources` | wall limits, cpus, memory, pids |

## Tool environment of a task (ADR-11, U28)

`task.json` `environment` keeps Harbor's meaning: `dir` is the agent workspace root, `cpus` and
`memory_mb` bound the grading containers. ADR-11 adds the **tool environment** of the agent run:
what the Solver may call. All keys are optional; a task without them gets the default (every
built-in tool, no MCP server, egress to the model gateway only). Schema:
`packages/contracts/schemas/task.schema.json`; helpers: `packages/contracts/tool-environment.js`.

| Our field (`environment.…`) | Source vocabulary | Meaning |
|---|---|---|
| `tools.builtin` | Inspect: the tools given to the Solver | Allow-list of harness built-ins: `read`, `write`, `edit`, `bash`, `search`, `list`, `todo` |
| `tools.mcp[]` | Inspect: MCP tools of the Solver; Valkyrie: services the benchmark owns | MCP servers the runner starts per run as sidecars (U29) |
| `tools.mcp[].transport` | MCP | `stdio` (bridged by the runner) or `http` (streamable HTTP on the sandbox network) |
| `tools.mcp[].image` / `command` | Valkyrie `install_cmd`/`run_cmd` boundary | Exactly one: an OCI image, or an argv in a runner sidecar image |
| `tools.mcp[].seed` | Inspect: Sample `setup` / `files` | Bundle path of the test state loaded before the agent starts; never inside `environment.dir` |
| `tools.mcp[].allowed_tools` | Inspect: tool list of the Solver | The only tools of that server the agent can call |
| `tools.mcp[].expose_state_to_scorer` | Inspect: trusted plane (Scorer reads sandbox state) | The runner exports the final server state to the Scorers |
| `run_egress` | Valkyrie `run_egress` (task side) | `model-gateway` (always), `mcp` (the declared sidecars). Intersected with the run profile |
| `secrets` | Valkyrie `secrets` | Names only; injected into the MCP sidecars that list them, never into the agent sandbox |
| `resources` | Valkyrie `resources` | Upper limits of the agent sandbox; the runner takes the lower of task and run profile |

Neutral built-in name → opencode tool names (`OPENCODE_BUILTIN_TOOLS`): `read` → read, `write` →
write, `edit` → edit + patch, `bash` → bash, `search` → grep + glob, `list` → list, `todo` →
todowrite + todoread. There is no web tool: the run has no internet.

**Agent `requires`** (`agents.requires`, migration `0011_agent_requires.sql`): what the agent
needs from a task, entries `mcp:<server>` or `tool:<builtin>` (a bare name means `mcp:<name>`).
A chip field on screen 02, stored on the agent (`POST /agents`, `PATCH /agents/:id`, returned by
`GET /agents/:id`), not parsed from AGENTS.md. **Compatibility** (`checkCompatibility`): every
requirement must be offered by the task. `GET /tasks/:idOrSlug/compatibility?agentId=` answers
`{ compatible, reasons[] }`; `POST /evaluations/quote` refuses an incompatible pair with
`422 { code: "incompatible", incompatible: [{ taskId, slug, reasons }] }`, before any payment.

## Harbor task layout (the Task contract)

See `services/evaluator/README.md` for the full mapping of `task.json` fields to Harbor's
`task.toml` sections (`[task]`, `[metadata]`, `[environment]`, `[verifier]`, `[agent]`) and to the
directories `instruction.md`, `environment/`, `tests/`, `solution/`.

## Pinned evidence: in-toto Statement v1

From evidence schema `itera-evidence/v2`, the document pinned to IPFS is an in-toto Statement v1
(`_type`, `subject`, `predicateType`, `predicate`), with no DSSE signature. The predicate is the
former v1 document (the run binding and the redacted EvalLog). The on-chain `manifest_sha256` keeps
its meaning: it is the sha256 of the exact pinned bytes. Proofs minted before the change keep their
v1 bytes. `apps/web/src/verify.ts` reads both shapes. Schema:
`packages/contracts/schemas/evidence-statement.schema.json`.
