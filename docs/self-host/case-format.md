# The case format: `tma-case/1`

A case is one problem that you test an agent on.
A case file is one JSON file named `case.json`.
The kit reads it with `tma eval case`.

Cases and their pins live in a separate private repo, the "eval repo".
A third party keeps its own repo in the same format.
The path in that repo is `cases/<type>/<subtype>/<case key>/case.json`.
The file holds pointers, digests and short human text.
It never holds a prompt, a model answer, a patch or a file body.

The reader is `services/runner/src/cli/eval/case.ts`.
The reader refuses an unknown key at every level.

## Limits

- The file is at most 256 KiB.
- The file must be valid JSON.
- A case that the reader accepts always uploads.

## Fields

| Field | Required | What it holds |
|---|---|---|
| `schema` | yes | The text `tma-case/1`. |
| `case_key` | yes | The name of the case. Lowercase letters, digits, `_` and `-`. 3 to 63 characters. No dot. |
| `use_case` | yes | The pair `<type>/<subtype>`, for example `fix/red-ci`. Lowercase letters, digits and `-`. At most 31 characters on each side. |
| `l2_tag` | no | A cluster key, for example `webhook-dedupe`. 2 to 80 characters. |
| `task_summary` | no | An object `{before, expected}`. One line each, 1 to 280 characters. |
| `mode` | yes | `replay` or `trace_review`. |
| `answer_shape` | yes | `single` or `open`. |
| `pin` | yes | `null`, or `{pin_sha256, record}`. |
| `task_ref` | yes | `{kind, id}`. Which task the case uses. |
| `expected` | yes | `{text, written_by, written_at}`. What a good result is. |
| `graders` | yes | A list with at least one grader. |
| `split` | yes | `golden`, `calibration-train`, `calibration-dev`, `calibration-test` or `none`. |
| `source` | yes | `trace`, `a11-build-case` or `synthetic`. |

### `task_summary`

The text uses letters, digits, spaces and `. , ; : ! ? ( ) / ' " _ + % & @ # = * -`.
The key `outcome` is refused.
The outcome of a run describes one run.
It stays on the host.

### `mode`

- `replay`: the kit runs a variant on the task and grades the output.
- `trace_review`: the kit grades an output that was recorded earlier. It runs nothing.

### `pin`

A pin fixes the origin of the case: the repo, the base commit and the agent.
Its record has the format `tma-pin/1`.
`pin_sha256` is 64 lowercase hex characters and must match the record.

- A `replay` case needs a complete `tma-pin/1` record. A partial pin is refused.
- A case with `source: "trace"` needs a pin that is not `null`.
- A case that is `synthetic` may have `pin: null`. It stays on your host: `tma eval upload` refuses it.

### `task_ref`

- `kind`: `tma-task` or `dfl-task`.
- `id`: 3 to 120 characters.

For `tma-task` the id is `<slug>@<version>`, for example `tsk_webhook_dup@1.0.0`.
The kit looks for the bundle `benchmarks/<slug>` in the runner.
The major version of the case must match the version of the bundle.
For another task give the folder with `tma eval case --task-dir <bundle>`.

### `expected`

- `text`: 1 to 4000 characters.
- `written_by`: 1 to 80 characters.
- `written_at`: an RFC 3339 date-time, for example `2026-11-12T18:30:00Z`.

`expected.text` stays in the eval repo.
The upload never carries it.

### `graders`

Each entry has these keys:

| Key | Rule |
|---|---|
| `id` | A grader id. Lowercase letters, digits and `-`. 2 to 64 characters. |
| `version` | A semver `x.y.z`. |
| `weight` | A number above 0. |
| `hard_gate` | `true` or `false`. A failed hard gate scores the case 0. |
| `decisive` | Optional. `true` or `false`. |

A case lists a grader once, at one version.
The built-in grader is `hidden-tests`.
Its version is the version of the evaluator.
A grader that the kit does not have at the exact version is "not measured".
It is never a pass and never a fail.

## A complete example

```json
{
  "schema": "tma-case/1",
  "case_key": "webhook-dup-replay",
  "use_case": "fix/red-ci",
  "l2_tag": "webhook-dedupe",
  "task_summary": {
    "before": "A webhook handler applies a duplicate delivery twice and never checks the signature.",
    "expected": "A duplicate delivery is applied once by event id; a bad signature is refused; the hidden tests pass."
  },
  "mode": "replay",
  "answer_shape": "single",
  "pin": null,
  "task_ref": { "kind": "tma-task", "id": "tsk_webhook_dup@1.0.0" },
  "expected": {
    "text": "The ledger verifies the HMAC signature, applies each event id once and never moves a settled entry back. Every hidden test passes.",
    "written_by": "claude-main",
    "written_at": "2026-11-12T18:30:00Z"
  },
  "graders": [{ "id": "hidden-tests", "version": "0.3.0", "weight": 1, "hard_gate": true }],
  "split": "none",
  "source": "synthetic"
}
```

This file is `services/runner/examples/eval/tsk_webhook_dup/case.json`.

## The case folder

`tma eval case` turns the file into a case folder on your host.

| Path | What it holds |
|---|---|
| `case.json` | A byte copy of the file. |
| `case.lock.json` | The digests of the manifest, the pin and the task bundle. |
| `input/` | What the agent sees: the public files and `INSTRUCTION.md`. |
| `runs/` | One folder for each variant. |
| `recorded.diff` | A `trace_review` case only. A link to your recorded output. |

The kit checks the lock on every later command.
It refuses a folder if `case.json` or the task bundle changed.
Build the folder again in this case.

## The variant file: `tma-variant/1`

A variant is the thing that you test: one change on a base agent.
Two kinds exist.

A patch variant grades a fixed output. It needs no model and no key.
The path is relative to the variant file.
`"patch": null` means no change.

```json
{
  "schema": "tma-variant/1",
  "label": "reference solution",
  "kind": "patch",
  "patch": "solution.patch",
  "change_kind": "none",
  "is_baseline": true,
  "prediction": null
}
```

An agent variant runs opencode with an agent folder and a model.
It needs your model key, as `tma run` does.

```json
{
  "schema": "tma-variant/1",
  "label": "stricter rules",
  "kind": "agent",
  "agent": { "agent_dir": "./agent", "model": "<model id>" },
  "change_kind": "rules",
  "is_baseline": false,
  "prediction": "what you expect against the baseline"
}
```

- `label`: 1 to 60 characters. Letters, digits, space and `. , : ; / ( ) + - _ % $ = & ' #`.
- `change_kind`: `prompt`, `rules`, `skill`, `retrieval`, `memory`, `model`, `tools`, `mcp`, `permissions`, `orchestration`, `limits`, `harness` or `none`.
- A baseline has `change_kind: "none"` and `prediction: null`.
- A variant that is not a baseline needs a written `prediction`. It has 1 to 4000 characters. Write it before the first run.
- The kit keeps the prediction in `prediction.md`. It refuses a changed prediction later.
- A patch is at most 4 MiB.
- `agent.profile` is optional. It names a run profile.
