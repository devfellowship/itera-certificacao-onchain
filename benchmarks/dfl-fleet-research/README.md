# fleet-research (task A of plan 20261012-testmyagent-dfl-benchmark-tasks)

A research task over a synthetic fleet of **14 real git repos in 2 orgs**, served by the
`repos@2` catalog server (`mcp/catalog/repos/`). The agent answers 6 questions with cited
evidence (`org/repo:path:line` + an exact quote) and writes `out/answers.json` and `out/report.md`.

| Fact | Question | What it tests |
|---|---|---|
| 1 | q1 — which repo holds "the Acme player" | **topology trap**: `acmehq/acme-player`, not `acme/acme-iterate` (whose README names the player) |
| 2 | q2 — which workflow applies migrations to production on merge | a decoy workflow only validates on pull requests |
| 3 | q3 — duplicate skill pairs in `acme/acme-harness` (20 skills) | a set: 3 true pairs (same `purpose:`), 2 look-alike name pairs that are not duplicates; F1 ≥ 0.8 |
| 4 | q4 — the workflow that breaks CI rule R1 | needs the rule file + the visibility inventory; a public repo using `ubuntu-latest` is allowed |
| 5 | q5 — files that reference the payments API key vault path | a set of 2; a third file references a different secret (path only, no value) |
| 6 | q6 — the Helm chart of `acme-services` | **unanswerable**: the correct output is `not_verified`. An answer = hard FAIL |

## Files

- `fixtures/gen.mjs --seed N` — writes the seed, the answer key, the mcp assertions and the
  reference solution from one seed. Seed 1 is the open variant (`task.json` `metadata.variant`).
- `fixtures/check.mjs` — CI: reproducible from the seed, the solution passes 13/13, the no-op
  skeleton and a fabricated q6 fail, a wrong-line citation fails, denylist + secret scan.
- `tests/hidden/grade.mjs` — the grader (13 checks, also a CLI); `grade.test.ts` makes one vitest
  case per check. `tests/hidden/mcp/repos/assert.json` — **evidence was read**: the key files are
  in the `repos` read log (`mcp_state` scorer).
- `solution/` — `solution.patch` (answers + report), `mcp-calls.jsonl` (the reads).

## Grading notes

- A citation may be **±1 line** off, no more. Version 2 keeps this rule strict (TMA-QA = C). The check
  proves it: +-1 passes, 2 lines off fails.
- `fixtures/check.mjs` also checks that the reference solution cites the exact line and reads every
  cited file with `read_file_lines`.
- Plan weights (45/20/10/15) map to case counts: hidden = 1 schema + 5 answers + 5 evidence +
  1 abstention + 1 report; the read log is the separate `mcp_state` scorer. PASS needs all.

## Versions

| Task version | Catalog | Why |
|---|---|---|
| 1 | `repos@1` | First version (K5). The read tools print no line numbers, so the agent counted lines. Campaign `k7-dfl-bench-1`: a free model cited line 11 for text on line 13, and failed the evidence check. |
| 2 | `repos@2` | TMA-QA = C (TG 21527). `repos@2` adds `read_file_lines`, a read tool with line numbers. The instruction tells the agent to take the line number from it. The grader, the questions, the seed and the key are the same as in version 1 (same seed 1). |

Version 1 is not edited: it stays as a published row in `task_packs`. Version 2 is a new row.

## Validate

```bash
node benchmarks/dfl-fleet-research/fixtures/check.mjs
npm run cli -w @itera/evaluator -- --validate --task ../../benchmarks/dfl-fleet-research   # no Docker: mcp step skipped
```
