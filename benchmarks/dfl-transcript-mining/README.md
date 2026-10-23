# transcript-mining (plan 20261023-tma-transcript-mining-executor-bakeoff, task T3)

The agent mines **one** agent-session transcript (`environment/item.txt`) into **one** strict JSON
record (`out/record.json`, the shape of `environment/rubric/schema.json`). The task compares
executors on the same item set: same contract, same instruction, same grader; only the executor changes.

**This folder holds synthetic data only.** The open variant and the second fixture are invented
(org `acme`, hosts under `example.test`). The real variants (one per golden item) are built on the
private side from the same contract and grader, and never enter this repository.

## Files

| Path | What |
|---|---|
| `task.json`, `instruction.md` | the contract and the prompt. The same for every variant. The instruction is the output contract of the production mining prompt, with the transcript moved to `item.txt`. |
| `environment/item.txt` | the open variant: a synthetic main session (`synth-acme-main-1`) |
| `environment/rubric/` | `schema.json` (the record schema) and a synthetic directive set and skill list. A private variant replaces the two `.md` files with the real ones. |
| `tests/hidden/lib/grade.mjs` | the shared grader. Its logic is byte-identical to the private bake-off grader; only the corpus path default and one comment differ, and the private side checks that. |
| `tests/hidden/grade.mjs` | turns one grader result into 12 checks, and prints the metric numbers (CLI) |
| `tests/hidden/grade.test.ts` | one vitest case per check (the evaluator reads the vitest JSON report) |
| `tests/hidden/golden.json` | the golden label of the open variant |
| `tests/public/record-shape.test.ts` | shape only: one object, the 14 keys, `item_id` copied |
| `solution/record.json`, `solution/solution.patch` | the reference record and the patch that creates `out/record.json` |
| `fixtures/synthetic/` | a second synthetic transcript, a SUBAGENT item, with its golden label (no corrections) |
| `fixtures/grade.selftest.mjs` | the grader self-test (copy of the private one; only the import path differs), with `--mutants` |
| `fixtures/check-labels.mjs` | the golden label shape checker (copy of the private one; only the corpus default differs) |
| `fixtures/denylist.mjs` | the denylist scan of this folder |
| `fixtures/check.mjs` | CI: runs all of the above |

## Hidden checks (12)

| Check | Kind | Pass rule (one item) |
|---|---|---|
| `schema` | gate | the strict record rules: required keys, no extra key, per-item keys, closed enums |
| `redaction` | gate | no quote rebuilds the text behind a `<REDACTED:kind>` marker |
| `quote_literalness` | metric | literal contract quotes / contract quotes ≥ 0.90 (a MarkdownV2 escape is an artefact, not a fabrication) |
| `corrections_recall` | metric | core golden corrections found ≥ 0.80 (a match = ≥ 50 % overlap with the golden anchor) |
| `corrections_precision` | metric | matched / predicted ≥ 0.85 |
| `decisions_recall` | metric | core golden decisions found ≥ 0.70 |
| `decisions_precision` | metric | matched / predicted ≥ 0.70 |
| `abstention` | metric | subagent item: 0 predicted corrections that match no golden one (main item: not applicable, pass) |
| `meta_domain`, `meta_type`, `meta_outcome` | metric | exact match |
| `links_f1` | metric | set F1 of `session_meta.links` ≥ 0.50 (task-local; the plan only reports it) |

When a gate fails, every metric check fails too. A ratio with a zero denominator (no core golden label,
no prediction, no quote) is `null` and passes. The thresholds are the plan's Phase 4 thresholds applied
to one item; the executor verdict is computed on the pooled numbers, not on these booleans.

`node tests/hidden/grade.mjs --record <record.json> --item <item.txt> --golden <golden.json>` prints
`{ pass, passed, total, gates, metrics, checks, result }`. `metrics` holds the numbers, and `result` is
the raw grader output, so many runs pool with `aggregate()` of `lib/grade.mjs`.

## Validate

```bash
node benchmarks/dfl-transcript-mining/fixtures/check.mjs
npm run cli -w @itera/evaluator -- --validate --task ../../benchmarks/dfl-transcript-mining
```

`check.mjs` asserts: the self-test passes and every grader mutant is killed; both golden labels pass
`check-labels.mjs`; the reference record passes 12/12 and the no-op passes 0/12; the patch creates
exactly `solution/record.json`; a gate failure fails every metric; an invented quote fails
`quote_literalness`; on the subagent fixture an empty corrections array passes `abstention` and one
invented correction fails it; the denylist scan is clean, and a copy with an internal host turns it red.

## Versions

| Task version | Grader | Why |
|---|---|---|
| 1 | 1.2.0 | First version. |
