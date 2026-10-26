# @itera/evaluator — task contract and generic verifier

## Task contract (`task.json`)

A task version is a bundle. The layout and the field names follow Harbor's task format
(`harbor-framework/harbor`, `src/harbor/models/task/config.py` and `paths.py`, task schema 1.4,
Apache-2.0). The schema is `packages/contracts/schemas/task.schema.json` (JSON Schema 2020-12),
validated with Ajv by `@itera/contracts`.

```text
task.json            the contract
instruction.md       the prompt the agent receives            (Harbor: instruction.md)
environment/         the starting repository = workspace root (Harbor: environment/)
tests/public/        copied into the agent workspace          (Harbor: tests/)
tests/hidden/        grading container only, after the patch is frozen
solution/*.patch     reference solution, for the validation gate only (Harbor: solution/solve.sh)
```

| Field | Harbor equivalent | Meaning |
|---|---|---|
| `schema_version` | `schema_version` | `"1.0"` |
| `task.{name,version,description,authors,keywords}` | `[task]` | `name` is `org/name` |
| `metadata` | `[metadata]` | free form; `metadata.tags.{tools,concepts}` |
| `instruction` | `instruction.md` | path of the Markdown prompt |
| `environment.{dir,install,allow_internet,cpus,memory_mb}` | `[environment]` | `allow_internet` must be `false`; `install` default `npm ci` (always `--ignore-scripts`) |
| `tests.{public,hidden}` | `tests/` | two directories, mounted at the same relative path |
| `solution.patch` | `solution/` | unified diff against `environment/` |
| `editable_paths`, `protected_paths` | — | globs; a changed file must match an editable glob and no protected glob, or the run is `invalid` |
| `verifier.{cmd,report,timeout_sec}` | `[verifier] timeout_sec` + `tests/test.sh` | argv, no shell; `{tests}` → the suite directory, `{report}` → the report path; report format `vitest-json` |
| `agent.timeout_sec` | `[agent] timeout_sec` | |
| `est_minutes` | — | shown in the catalog |

`loadTask()` also refuses: a path outside the bundle, a symbolic link or special file anywhere,
`.npmrc` / `.yarnrc`, a lockfile entry resolved outside `registry.npmjs.org`, and
`protected_paths` that do not cover both test directories.

## Grading

`runEvaluation({ taskDir, patch, executor })` builds the workspace (environment + public tests),
installs, records a git baseline, runs the public suite, applies the patch with git
(`--index --no-renames`), checks the scope, runs the public suite again, mounts the hidden tests,
runs the hidden suite and scores (weights in `src/score.ts`). The **executor** decides where the
verifier command runs: `localExecutor()` (child process, NOT a sandbox: CLI, tests, legacy API
path) or the runner's sandbox executor (`services/runner/src/grade.ts`, one fresh container per
suite). A report counts only when it agrees with the verifier exit code; otherwise the suite is
`report_mismatch` / `no_report` / `timeout` and the run gets an error, never a score.

### Score version 2 (2026-10-15, TMA-QC = B)

`score.total` = `round(hidden.passed / hidden.total × 100)` when every gate holds, else 0
(`hiddenRatioScore` in `src/score.ts`). The gates: the hidden suite was measured, the patch is not
empty, the patch stays inside `editable_paths` (else INVALID), and every final-state assertion of a
scored MCP server holds. The runner adds one gate: the agent finished inside its wall limit and
cost cap (a `timeout` run scores 0). An `infra_error` run stays unscored, as before.

Why: under version 1 (the sum of five parts) public tests, regression, scope and evidence came
free on output-only tasks, so a timeout with 1 of 13 hidden checks scored 77 (campaign
`k7-dfl-bench-1`). The five parts stay in the `score` block as diagnostics.

Every new EvalLog carries `score_version: 2` and `score_rule` (formula, hidden ratio, gates,
`legacy_total`). A log without `score_version` is version 1. The on-chain SAS schema does not
change: `score_total` stays a U8 from `runs.score_total`, and the pinned in-toto evidence carries
the version. Stored runs are not rescored. `services/runner/src/score-v2-preview.ts` is a
read-only operator CLI that prints what version 2 would give to old runs.

`validateTask({ taskDir, executor, repeats })` is the validation gate of ADR-8.

```bash
npm run cli -w @itera/evaluator -- --scenario tsk_webhook_dup --patch ../../benchmarks/tsk_webhook_dup/solution/solution.patch
npm run cli -w @itera/evaluator -- --validate --task ../../benchmarks/tsk_webhook_dup
```
