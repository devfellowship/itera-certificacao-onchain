# The upload contract

This page says what leaves your host when you run `tma eval upload`.
It also says what never leaves.
The schemas are in `packages/contracts/schemas/`:

- `local-result-v2.schema.json` (`tma-local-result/2`)
- `local-result-v3.schema.json` (`tma-local-result/3`)
- `trajectory.schema.json` (`tma-trajectory/1`)
- `trajectory-v2.schema.json` (`tma-trajectory/2`)

The hosted path and this path write the same result contract.

## Principle

A body holds numbers, digests, identifiers and a few short labels.
Every object is closed. An unknown key is refused.
Every string has a pattern and a length limit.
Every number has a range.
The body has no key for a prompt, a message, a model answer, a patch, an output, stdout, stderr, a file body or a key.

Check the body before you send it:

```bash
tma eval upload --case ./case --variant-dir ./case/runs/<sha12> --agent <agent id> --dry-run
```

The command prints the exact body.
If you are logged in, it also asks the API to check the body.
The API writes nothing in this case.

## What never leaves your host

- The prompt and every model message.
- The text of the model answer and the tool output.
- The patch, and every file body.
- The arguments of a tool call. Only their sha256 leaves.
- The prediction text. Only its sha256 leaves.
- `expected.text` of the case.
- The task files and the hidden tests. Only digests leave.
- Your model key and your session token.
- The folder `runs/<sha12>/<run id>/` with `patch.diff`, `run.json`, `evidence.json` and `grades.json`.

## Fields of `tma-local-result/2`

### Top level

| Field | What it holds |
|---|---|
| `format` | `tma-local-result/2`. |
| `agent_id` | The UUID of your agent. |
| `task` | Exactly one of `catalog` or `local` (see below). |
| `metrics_shape` | `tma-score/1` for the eval kit. |
| `grader_version` | The evaluator version, `x.y.z`. |
| `runner` | `{version, execution, profile, sandbox_image_id}`. `execution` is `tma-sandbox` or `external`. |
| `executor` | `{model_id, provider, route, harness, variant, cost_source, model_effective}`. |
| `ran_from`, `ran_to` | UTC times, for example `2026-11-12T18:30:00Z`. |
| `summary` | `pass_rate`, `time_per_task_s`, `cost_per_task_usd`, `cost_total_usd`, `tokens_in_total`, `tokens_out_total`, `errors`, `score`, `runs`, `items`. |
| `runs` | The runs. At most 50. |
| `case` | The case (see below). |
| `variant` | The variant (see below). |
| `comparison` | `{is_baseline, prediction_sha256}`. |

`task.catalog` is `{slug, version}`: a curated task and its version.
`task.local` is a private task folder.
It holds `slug`, `name` (60 characters), an optional `description` (120 characters), `contract_sha256`, `environment_sha256` and `hidden_tests_sha256`.
Only these digests leave the host.

### `case`

| Field | What it holds |
|---|---|
| `case_key` | The key of the case. No dot. At most 63 characters. |
| `manifest_sha256` | The digest of `case.json`. |
| `origin_pin_sha256` | The digest of the pin, or `null`. |
| `mode` | `replay` or `trace_review`. |
| `use_case_key` | `<type>/<subtype>`. |

### `variant`

| Field | What it holds |
|---|---|
| `agent` | The base agent: `harness`, `harness_version`, `harness_repo_sha`, `model_id`, `rules_sha256`, `skills_sha256`, `mcp_manifest_sha256`, `tools_sha256`. Eight fields. A field may be `null`. |
| `variant_sha256` | The digest of the one change on the base agent. For `change_kind: "none"` it is the sha256 of the empty string. |
| `label` | The name of the variant. At most 60 characters. |
| `change_kind` | One of `prompt`, `rules`, `skill`, `retrieval`, `memory`, `model`, `tools`, `mcp`, `permissions`, `orchestration`, `limits`, `harness`, `none`. |

### Each run in `runs`

| Field | What it holds |
|---|---|
| `item_sha256` | The digest of the task item. |
| `repeat` | The number of the repeat, 1 to 100. |
| `status` | `pass`, `fail`, `invalid`, `timeout` or `infra_error`. |
| `score` | 0 to 100. |
| `wall_s`, `cost_usd`, `tokens_in`, `tokens_out` | Numbers, or `null`. |
| `error_class` | `timeout`, `empty_output`, `rate_limited`, `hang`, `infra_error`, `cost_capped` or `null`. |
| `parts` | The five score parts and, for an MCP task, `mcp_state`. Or `null`. |
| `tests` | Test counts for `public_baseline`, `public_after_patch` and `hidden`: `total`, `passed`, `failed`. No test name. |
| `infra_ok` | `true` if the run was measured. |
| `graders` | The grader rows. At most 32. |
| `trajectory` | A `tma-trajectory/1` record, or `null`. |

One run exists for each `(item_sha256, kind, repeat)`.
A grader id appears once in a run.

### Each grader row

| Field | What it holds |
|---|---|
| `id`, `semver` | The grader and its version. |
| `code_sha256` | The digest of the grader code. |
| `kind` | `code`, `judge` or `human`. |
| `pass`, `score` | The result. |
| `weight`, `hard_gate`, `decisive` | How the case counts the result. |

## Fields of `tma-local-result/3`

A `/3` body is a `/2` body plus these optional fields.
The API accepts both.
The kit sends `/3` only when a body needs one of them.

| Field | Where | What it holds |
|---|---|---|
| `case.task_summary` | case | `{before, expected}`, 280 characters each. No `outcome` key. |
| `proof` | grader | `{caught, total}`: the planted bugs that the grader caught. |
| `calibration` | grader | `{n_labels, n_test, tp, fn, tn, fp, realigned_at}`: counts and one date. |
| `note` | grader | A version note. At most 60 characters. |
| `author` | grader | The key of the grader author. Never an e-mail address. |
| `labeler` | grader | The key of the person who wrote a human label. |
| `reason_code` | grader | `wrong_sha`, `no_check`, `partial`, `other` or `null`. |
| `trajectory` | run | `tma-trajectory/1` or `tma-trajectory/2`. |

`tma eval upload --mode trace_review` makes a `/3` body when the label has `labeler` or `reason_code`, when the case has a task summary, or when the trajectory is `tma-trajectory/2`.
Else it makes a `/2` body.

## The trajectory: `tma-trajectory/1` and `/2`

A trajectory has one step for each tool call.
The record holds at most 2,000 steps.
A step has these fields:

| Field | What it holds |
|---|---|
| `seq`, `parent_seq`, `turn` | The order of the call, its parent call, and the model turn. |
| `tool` | The tool name as the harness writes it. At most 128 characters. |
| `tool_family` | `builtin`, `shell`, `git`, `gh`, `ssh`, `web`, `skill-bash`, `mcp`, `agent` or `other`. |
| `status` | `ok`, `error`, `denied` or `timeout`. |
| `error_class` | `tool_error`, `invalid_args`, `not_found`, `permission`, `timeout`, `rate_limited`, `network`, `interrupted`, `other` or `null`. |
| `duration_ms`, `tokens_in`, `tokens_out` | Numbers, or `null`. |
| `target_kind` | `file`, `dir`, `url`, `host`, `repo`, `agent`, `skill`, `mcp`, `command`, `pattern` or `none`. |
| `target_redacted` | The redacted target. At most 120 characters. |
| `args_sha256`, `result_sha256` | The digests of the arguments and of the result. |
| `retry_of` | The step that this step retries, or `null`. |

A `tma-trajectory/2` step also has these fields:

| Field | What it holds |
|---|---|
| `step_kind` | `read`, `search`, `write`, `test`, `mcp`, `shell`, `agent` or `other`. The uploader sets it on your host. |
| `started_ms` | The start of the step, in ms from the start of the run. |
| `turn_origin` | `human`, `agent`, `system` or `null`. |

## Redaction rules

One module writes `target_redacted`: `services/runner/src/cli/eval/redact.ts`.
The rule is: keep the shape, drop the content.

| Target | What stays |
|---|---|
| file, dir | A path relative to `--root` and to the session folder. The home folder becomes `~`. |
| command | The program, and the sub-command words of a known tool, for example `git pr view`. For another program, the script path, for example `bash x/run.sh set`. Never a flag, a value or free text. |
| url | The scheme, the host and the path. No query, no fragment, no user name. |
| pattern | A short pattern with no space. A pattern with a space is a sentence. It becomes `<pattern>`. |
| agent | The type of the sub-agent only. |
| agent, skill, mcp, host, repo | A short name in the safe set of characters. Else `<name>`. |

Then the module applies three more rules:

- A value that looks like a credential becomes `<redacted>`. This covers `sk-` keys, bearer tokens, JWTs, GitHub tokens, AWS key ids, Slack tokens, `password=`, `token=` and `api_key=`. It also covers a long token with many digits.
- The string keeps only these characters: letters, digits, space and `. _ / : @ # % + = , ( ) < > [ ] * ~ ^ ! ? -`.
- The string has at most 120 characters.

The uploader also scans the whole body for a credential before any network call.
It refuses to send a body that holds one.

## Size caps

| Item | Cap |
|---|---|
| A `tma-local-result/2` or `/3` body | 4 MiB |
| A `tma-local-result/1` body (`tma upload`) | 1 MiB |
| Runs in one body | 50 |
| Steps in one trajectory | 2,000 |
| `target_redacted` | 120 characters |
| `variant.label` | 60 characters |
| `case.task_summary` fields | 280 characters each |
| `case.json` | 256 KiB |
| A patch variant file | 4 MiB |
| Results from one account | 50 in 24 hours (the default of the API) |

## Refusals before any network call

The kit refuses these cases on your host:

- A `case_key` with a dot, or with more than 63 characters.
- A replay case with no pin. The kit prints this line:

```text
tma eval: case webhook-dup-replay is a replay case with no pin: tma-local-result/2 needs the origin pin of a replay case (case.origin_pin_sha256). A synthetic case stays local.
```

- A variant that is not a baseline and has `change_kind: "none"`. A control output stays local.
- A body with a value that looks like a credential.
- A body above 4 MiB, or with more than 50 runs.
- A trajectory with `tma-trajectory/2` in a `/2` upload. Such a body needs `tma-local-result/3`.

## Error codes of the API

The API answers `POST /self-declared-results` with a JSON body `{error, message}`.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `not_json` | The body is not JSON. |
| 400 | `unknown_key` | The body has a key that the contract does not list. The `path` names it. The API names this code first when several issues exist. |
| 400 | `invalid` | A value breaks a pattern, a range or a length limit. |
| 400 | `inconsistent` | Fields disagree. Example: a baseline with a change kind other than `none`. |
| 400 | `unknown_route`, `unknown_provider` | The model route or the provider is not in the catalog. |
| 400 | `unknown_model` | The model is not in the catalog. |
| 401 | (a message, no code) | There is no valid session. Run `tma login`. |
| 403 | `self_declared_dfl_only` | The session is not a Login with DFL session. |
| 404 | `agent_not_found` | The agent id is not yours. |
| 404 | `task_not_found`, `task_version_not_found` | The task or its version is not known. |
| 409 | `agent_has_no_version` | The agent has no version yet. |
| 409 | `case_conflict` | The case exists with another pin, mode, use case or task summary. |
| 409 | `variant_conflict` | The variant exists with another change kind. |
| 409 | `baseline_exists` | The case has a baseline already. |
| 409 | `prediction_conflict` | The runs exist with another prediction. |
| 409 | `grader_conflict` | The grader version exists with other values. A new value needs a new semver. |
| 409 | `conflicting_rows` | A row with this id exists with another owner or origin. |
| 413 | `payload_too_large` | The body is above 4 MiB. |
| 429 | `self_declared_quota` | The daily limit is reached. |
| 503 | `schema_not_ready` | The database of the API is not migrated yet. Try again later. |

`--dry-run` shows these errors and writes nothing.

## Idempotence

Send the same body again.
The API answers `unchanged` and adds no row.
Send a changed body for the same agent and case.
The API answers `updated` and replaces the numbers.
