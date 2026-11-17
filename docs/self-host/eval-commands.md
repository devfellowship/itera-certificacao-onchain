# The eval kit: `tma eval`

The eval kit tests an agent change against a fixed case.
It runs on your host.
Nothing leaves your host until you run `tma eval upload`.

Read [`install.md`](install.md) first.
The commands below use the `tma` function that `install.md` defines.
Run them from the folder `services/runner` of the clone.

## The flow

1. `tma eval case`: build a case folder from a case file.
2. `tma eval run`: run a variant N times and grade each run.
3. `tma eval grade`: grade again, or grade with `--dry-run`.
4. `tma eval diff`: compare a variant with the baseline.
5. `tma eval trajectory`: read a harness trace into a structural record.
6. `tma eval upload`: send the numbers.
7. `tma eval grader prove` and `tma eval judge calibrate`: prove a grader.

Docker must run for steps 2 and 3.
The case file format is in [`case-format.md`](case-format.md).

## Worked example: `tsk_webhook_dup`

The task `tsk_webhook_dup` is a public task.
A webhook handler applies a duplicate delivery twice and never checks the signature.
The example uses two patch variants:

- The reference solution of the task. It is the baseline.
- An empty output. It makes no change.

A patch variant needs no model key.
The sandbox image builds the first time you run it.

### Step 1: build the case folder

Pick a folder outside the clone.

<!-- e2e -->
```bash
export CASE="$HOME/tma-case"
tma eval case --case examples/eval/tsk_webhook_dup/case.json --dest "$CASE"
```

Expected output:

```text
case webhook-dup-replay (fix/red-ci, replay) written to <your folder>
manifest 049136d47ed1  task tsk_webhook_dup@1.0.0 env baf42a741bcc  pin none
next: tma eval run --case <your folder> --variant <variant.json> --repeat 3
```

The folder holds `case.json`, `case.lock.json`, `input/` and `runs/`.
The command refuses a folder that exists and is not empty.

### Step 2: run the baseline three times

<!-- e2e -->
```bash
tma eval run --case "$CASE" --variant examples/eval/tsk_webhook_dup/solution.variant.json --repeat 3
```

`--repeat` takes 1 to 10.
Each run applies the patch in a new sandbox.
The hidden-tests grader grades the result.
The command prints one row for each run:

```text
case webhook-dup-replay  variant 975d43576ebe (reference solution)  [baseline]
run             repeat  result         score  graders
local-ed3a0987       1  pass            100  hidden-tests@0.6.0=pass/100
local-beebeb05       2  pass            100  hidden-tests@0.6.0=pass/100
local-dd9de384       3  pass            100  hidden-tests@0.6.0=pass/100
n 3, measured 3, passed 3, mean score 100
runs: <your folder>/runs/975d43576ebe (outputs and evidence stay on this host)
```

The run ids differ on your host.
The three scores are 100.

### Step 3: run the empty variant

An empty output must fail.

<!-- e2e -->
```bash
tma eval run --case "$CASE" --variant examples/eval/tsk_webhook_dup/empty.variant.json --repeat 3
```

Expected output:

```text
case webhook-dup-replay  variant 06bdc6a03561 (empty output)
run             repeat  result         score  graders
local-cd5991af       1  fail              0  hidden-tests@0.6.0=fail/0
local-d3a96b53       2  fail              0  hidden-tests@0.6.0=fail/0
local-7ba88a0d       3  fail              0  hidden-tests@0.6.0=fail/0
n 3, measured 3, passed 0, mean score 0
runs: <your folder>/runs/06bdc6a03561 (outputs and evidence stay on this host)
```

The hidden tests stay red, so the hard gate fails.
A failed hard gate scores the case 0.
The command still exits with 0.
The runs were measured.
The exit code is 1 only when a run was not measured (`infra_ok` is false).

A variant that is not a baseline needs a written `prediction` before it runs.
The kit saves it in `runs/<sha12>/prediction.md`.

### Step 4: compare the two variants

The folder name is the first 12 characters of the variant digest.
Find the two folders.

<!-- e2e -->
```bash
BASE="$(dirname "$(grep -l '"is_baseline": true' "$CASE"/runs/*/variant.lock.json)")"
VARIANT="$(dirname "$(grep -l '"is_baseline": false' "$CASE"/runs/*/variant.lock.json)")"
tma eval diff "$BASE" "$VARIANT"
```

Expected output:

```text
case webhook-dup-replay
baseline  975d43576ebe  reference solution        n   3  measured   3  passed   3  mean 100
variant   06bdc6a03561  empty output              n   3  measured   3  passed   0  mean 0
delta mean score -100, delta pass rate -100 points

prediction (written before the runs)
No change to the ledger: the hidden tests stay red, so the hard gate fails and the case scores 0 on every run.

code diff (first run of each)
only in baseline: src/app.ts
only in baseline: src/ledger.ts
```

`tma eval diff` also takes two run folders or two files.
It compares files by type: `.diff` and `.patch` as code, `.json` as a tree, `.md` by section, other files by line.

### Step 5: grade with `--dry-run`

A dry run grades and prints the verdict as JSON.
It writes no file in the case folder.
It makes no network call.
First, take a digest of the case folder.

<!-- e2e -->
```bash
find "$CASE" -type f | sort | xargs sha256sum | sha256sum
```

Grade the empty variant:

<!-- e2e -->
```bash
tma eval grade --case "$CASE" --variant-dir "$VARIANT" --dry-run
```

The output starts with this text:

```text
{
  "format": "tma-eval-dry-run/1",
  "dry_run": true,
  "case_key": "webhook-dup-replay",
```

Each output has the id of the run, the digest of its patch, one result for each grader, and the verdict of the case.
`--trace <file>` grades one output file instead of the runs.
`--trace` needs `--dry-run`.

Take the digest again.
The two digests must be equal.

<!-- e2e -->
```bash
find "$CASE" -type f | sort | xargs sha256sum | sha256sum
```

The clone must be clean too.
This command prints nothing:

<!-- e2e -->
```bash
git -C "$TMA_DIR" status --short
```

### Grade again, for real

`tma eval grade` without `--dry-run` grades again.
It ADDS a grading to each run.
The old gradings stay.

```bash
tma eval grade --case "$CASE"
```

Use `--run <run dir>` (repeatable) or `--variant-dir <dir>` to grade some runs only.
For a `trace_review` case, the command grades the recorded output.

## Variants that call a model

A variant of `kind: "agent"` runs opencode with an agent folder and a model.
It needs your model key, as `tma run` does.
Set the key in your shell.
The key goes only to the model gateway container of the run.

```bash
export OPENROUTER_API_KEY=...
tma eval run --case "$CASE" --variant ./my.variant.json --repeat 3
```

The format of the variant file is in [`case-format.md`](case-format.md).
An agent run writes `trajectory.json` next to `run.json`.

## Cap a campaign

A model on a subscription plan bills 0 dollars per run, so a cost cap cannot stop a campaign.
A campaign has a run-count cap instead.
The config holds the hard cap; the ledger next to it counts the runs.

```bash
tma eval campaign init --file ./c7.campaign.json --name c7-build-mcp-tool --max-runs 45 --paid-before 9
tma eval run --case "$CASE" --variant ./my.variant.json --repeat 3 --campaign ./c7.campaign.json
tma eval campaign charge --file ./c7.campaign.json --runs 1 --model zai-coding-plan/glm-5.3
tma eval campaign status --file ./c7.campaign.json
```

`tma eval run --campaign` charges the repeats before the first run starts.
The run that would pass `max_runs` is refused with `campaign_cap`, and nothing starts or is written.
A driver that runs a model outside the kit calls `charge` before each run.
A paid run is a run of a model that is not local and not a fleet Claude model.
`status` prints the runs against the cap and the paid runs against the 200 of the A11 budget.
The ledger is the one source of both counts.
`--paid-before` is the count of paid runs from before the ledger existed.
A paid run that would pass 200 is refused with `paid_cap`.

### Cap the tokens per provider

A subscription plan (Claude Code, Codex) also bills 0 dollars, so a comparison can cap the tokens per provider.
A provider label names the account that pays, for example `claude-code`, `codex` or `zai`.

```bash
tma eval campaign init --file ./c7t5.campaign.json --name c7t5 --max-runs 15 --token-cap claude-code=2000000 --token-cap codex=2000000
tma eval campaign charge --file ./c7t5.campaign.json --runs 1 --model anthropic/claude-sonnet-5.5 --provider claude-code
tma eval campaign record --file ./c7t5.campaign.json --provider claude-code --tokens-in 52000 --tokens-out 9000 --cache-read 800000 --cache-write 60000
```

Every token kind counts: input, output, cache read and cache write.
With token caps, a charge for a model run must name its `--provider`.
For a capped provider, `charge` is refused with `token_cap` while a charged run has no `record`.
It is also refused when the recorded tokens plus n times the largest recorded run would pass the cap.
The first run of a provider is the measure run.

### A patch written outside the kit

A driver that runs a harness on the host (Claude Code, Codex) grades the patch as a `patch` variant.
The variant names its `producer`, so the run and the upload carry that harness, model and tokens:

```json
{"schema":"tma-variant/1","label":"sonnet r1","kind":"patch","patch":"model.patch","change_kind":"none","is_baseline":true,"prediction":null,
 "producer":{"harness":"claude-code","model":"claude-sonnet-5-5","tokens_in":52000,"tokens_out":9000}}
```

The upload labels the agent with the producer harness and model, not with the model of the case pin.
Two producers that write the same bytes are two variants.

## Upload a replay case

```bash
tma eval upload --case "$CASE" --variant-dir "$VARIANT" --agent <agent id> --dry-run
```

`--dry-run` prints the exact body.
If you are logged in, it asks the API to check the body with `?dry_run=1`.
It writes nothing on the server.
Remove `--dry-run` to send the body.
The command needs `tma login` and an agent id from `tma agent create`.

The base agent comes from `--base-agent <file>`.
Else it comes from the pin of the case.
Else it comes from the agent folder of an agent variant.

The example case is `synthetic` and has no pin.
`tma eval upload` refuses it before any network call.
It stays on your host.
A case from the eval repo has a pin and uploads.

## Review a recorded session

A `trace_review` case grades an output that you recorded earlier.
Build the folder with the recorded patch:

```bash
tma eval case --case <case.json> --dest ./review --recorded <patch file>
tma eval grade --case ./review
```

The recorded patch is linked, not copied.
Read a Claude Code session into a structural record:

```bash
tma eval trajectory --from claude-code ~/.claude/projects/<project>/<session>.jsonl --root ~/repos --out t.json
tma eval trajectory --from opencode ./case/runs/<sha12>/<run-id>
```

`--root` is repeatable.
It names a folder whose prefix is dropped from paths.
`--out` writes the record to a file.
Else the command prints it.

Upload the session as one run of the variant `recorded session`:

```bash
tma eval upload --mode trace_review --case ./review --session <session>.jsonl --agent <agent id> --dry-run
tma eval upload --mode trace_review --case ./review --session <session>.jsonl --agent <agent id> --label-file label.json --dry-run
```

A label file is a JSON object:

```json
{ "grader_id": "<grader id>", "version": "1.0.0", "pass": true, "score": 100, "labeler": "<actor key>", "reason_code": "other" }
```

Only `grader_id`, `version` and `pass` are required.
The optional keys are `score`, `labeler`, `reason_code` and `code_sha256`.
A label holds no free text.

To add a label to a run that is already uploaded, add `--label-only`:

```bash
tma eval upload --mode trace_review --case ./review --session <session>.jsonl --agent <agent id> --label-file label.json --label-only
```

The API finds the same run and adds one grader row.
Without `--label-only`, every grader of the body gets a new row.

Other flags: `--variant-label <text>` and `--root <dir>` (repeatable).

## Upload many recorded sessions for review

`tma eval review-batch` uploads many recorded Claude Code sessions in one command.
Each session becomes one run on its own `trace_review` case.
The review screen of the studio lists these runs.

```bash
tma eval review-batch --batch rows.jsonl --agent <agent id> --judge async-wait-lifecycle@0.1.0 --dry-run
tma eval review-batch --batch rows.jsonl --agent <agent id> --judge async-wait-lifecycle@0.1.0
```

The batch file has one JSON object on each line:

```json
{"schema":"tma-review-batch/1","case_key":"<case key>","use_case":"<type>/<subtype>","task_ref":{"kind":"dfl-task","id":"<task id>"},"task_label":"<short id>","pin":{"pin_sha256":"<sha256>","record":{"format":"tma-pin/1"}},"session_file":"/abs/path/session.jsonl"}
```

- `pin.record` is the full `tma-pin/1` record. A pin with a missing field is accepted.
- `session_file` is an absolute path on your host. The file stays on your host.
- `task_summary` (`{before, expected}`) is optional. The command sends it only with `--with-summary`.

The runs are not graded.
Each run has no grader result, and `infra_ok` is `false`.
So a model comparison never counts these runs.
A judge result or a human label attaches to the run later.

The command builds every body before it sends one.
One bad row stops the command, and nothing is sent.
The same batch again answers `unchanged` for each row.

Other flags: `--root <dir>` (repeatable), `--limit <n>`.

## Write weak workflow labels on review runs

`tma eval workflow-labels` writes weak pass labels on the runs of a review batch.
A label comes from the outcome signals of the run, not from a model and not from a person.

```bash
tma eval workflow-labels --batch rows.jsonl --signals candidates.jsonl --judge async-wait-lifecycle --judge external-block-handling --out decisions.jsonl --dry-run
tma eval workflow-labels --batch rows.jsonl --signals candidates.jsonl --judge async-wait-lifecycle --judge external-block-handling
```

- `--batch` is the batch file of `tma eval review-batch`.
- `--signals` is a `trace-select` candidates file (`tma-trace-select/1`). It is repeatable; a later file wins for the same run.
- A row joins its candidate by task id, session id and sub-agent id. The ids come from the path of the Claude Code session file.

The rule is `clean-merge`.
The delivering PR merged with green CI, and every red signal of the run is known `false`: `revert`, `red_ci`, `rerun_task`, `ci_rerun` and `correction`.
A signal that is `null` was not measured, so the row gets no label.
No rule gives a fail label. Strong labels come from a person on the review screen.

The command sends `POST /grader-results/human` with `workflow_signal: "clean-merge"` and `reason_code: "other"`, one label for each run and judge.
The API stores the labeler `workflow:clean-merge` with the strength `weak`.
Only an agent login can write a workflow label, and only a pass.
The same label again answers `unchanged`.
`--out` writes one decision for each row (ids, the L1 pair, the signals and the decision; no task text).

## Prove a grader

A grader in the eval repo has a folder `graders/<id>/<semver>/`.
Each planted bug is a folder `fixtures/mutation-*/`.
The command runs the grader once for each fixture.
The grader prints `{"pass": true}` or `{"pass": false}` on its last output line.
A planted bug must not pass.
A crash, a timeout or no answer counts as a miss.

```bash
tma eval grader prove ./graders/<id>/<semver> --out proof.json
tma eval grader prove ./graders/<id>/<semver> --timeout 120 -- python3 grade.py
```

The command to run is, in order: the words after `--`, the key `command` in `grader.json`, or `python3 grade.py`.
The output looks like this:

```text
grader <id>@<version> (code <12 hex characters>): caught 3 of 3 planted bugs
proof: <path>/proof.json
```

The exit code is 0 only when every planted bug is caught.
`proof.json` holds ids, counts and digests.
It holds no grader output and no fixture text.

## Calibrate a judge

A judge grades with a rubric and a model.
A judge may be decisive only if it agrees with human labels.
The command measures the agreement.

```bash
tma eval judge calibrate --judge <id> --version <semver> --model <model id> --repo <eval repo folder>
```

The labels are the files `sets/calibration/<id>/train.jsonl`, `dev.jsonl` and `test.jsonl`.
Each line is `{"id": "<id>", "label": true}` or `{"id": "<id>", "label": false}`.
The rubric is `judges/<id>/<semver>/rubric.md`.
The command needs a test split.
A label id may be in one split only.

### The judge runner

By default no model is called.
Each test item then is "not measured", and the command writes no `calibration.json`.
To measure with a model, give the folder of the item texts and switch the runner on:

```bash
tma eval judge calibrate --judge <id> --version <semver> --model <model id> --repo <eval repo folder> --texts-dir <folder> --runner on --max-calls 100
```

The text of label id `<id>` is the file `<folder>/<id>.txt`.
The runner is off unless you give `--runner on`.
It calls the model through OpenRouter with your own `OPENROUTER_API_KEY`, at temperature 0.
`--max-calls` is the most model calls of one command (default 50, at most 1000).
The runner makes one call per test item and does not retry.
After the cap, an item is not measured and the command makes no more calls.
A model answer that is not one JSON object with a boolean `pass` is not measured.
The command prints how many calls it used.
The model must pass the private-text list unless you give `--public-set`.

On success the command prints:

```text
judge calibration: n_labels <n>, n_test <n>, tp <n> fn <n> tn <n> fp <n>
gate: decisive allowed (TPR and TNR >= 0.90)
written to <path>/judges/<id>/<semver>/calibration.json
```

A judge is decisive only if TPR and TNR are both 0.90 or more on the test split.
Else the line says `gate: side signal only` and gives the reason.
A case sets `decisive: true` for a judge.
The flag counts only with a passing calibration file.

The case set is private by default.
The command refuses a model that is not on the private-text list.
That list holds the fleet Claude models and local `ollama/` or `local/` models.
`--public-set` lifts this rule when the set is public.
Other flags: `--labels-dir <dir>` and `--judges-dir <dir>`.

The kit has no model runner wired in this version.
Without a runner, the command stops with this message:

```text
the judge did not measure <n> of <n> test item(s): no calibration.json is written
```

## What stays on the host and what is uploaded

| Item | Where it stays |
|---|---|
| The case folder and `case.json` | Host |
| The patch and every output | Host (`runs/<sha12>/<run id>/patch.diff`) |
| `run.json`, `evidence.json`, `grades.json` | Host |
| The prediction text | Host. Only its sha256 is uploaded. |
| The prompt and the model messages | Host. They are never read by the kit. |
| Your model key | Host. Only the model gateway of the run reads it. |
| The trajectory of tool calls | Uploaded in a redacted, structural form. |
| Scores, status, counts, wall time, cost, tokens | Uploaded |
| The grader id, version and code digest | Uploaded |
| The case key, the use case and the manifest digest | Uploaded |

`tma eval upload` is the only eval command that sends data.
Read [`upload-contract.md`](upload-contract.md) for each field.
