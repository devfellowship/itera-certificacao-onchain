# Session Decision Trajectory Extraction (plan 20261025-session-trajectory-extraction, task T13)

Task id `itera/dfl-session-decision-trajectory-extraction`. The agent judges **one** unit of agent work (a
subagent run, or a time chunk of a main session) and writes **one** strict layer-2 judgment
(`out/judgment.json`, the shape of `environment/rubric/schema.json`): durable decisions with risk, the human's
corrections, a fixed-taxonomy classification, summaries, the task intent, and an intent label for each shape that
the layer-1 parser could not label. The task **extracts and classifies only**; it never runs the work of the
session (plan ADR-17). Layer 1 (the script facts) is the input; only layer 2 is graded (plan ADR-13).

**This folder holds synthetic data only.** The open variant and the subagent fixture are invented (org `acme`,
hosts under `example.test`). The real variants (one per seed item S1–S10 of the plan) are built on the private
side from the same contract and the same grader, and never enter this repository.

## Files

| Path | What |
|---|---|
| `task.json`, `instruction.md` | the contract and the prompt. The same for every variant. The instruction is the layer-2 prompt of the contract, with the inputs moved to files. |
| `environment/item.txt` | the condensed view of the unit (the contract's `condensed-view.mjs` format): header, LAYER1 digest, RISK SIGNALS, then the events `m<N>` (messages) and `s<N>` (spans) |
| `environment/layer1.json` | the layer-1 run record of the unit. The grader reads `risk_signals` (floors), `unit.outcome_signals` and `links`. A main chunk keeps only its window, its own signals and a session-tree summary. |
| `environment/shapes.json` | the shapes to label (the contract's `shape-list.mjs` format, no cache) |
| `environment/rubric/` | `schema.json`, `intents.md`, `taxonomy.md` byte-identical to the contract (sha256 in `VENDORED.json`); `risk-anchors.md` is a generic stand-in with the same anchors and floor values. A private variant carries the contract's `risk-anchors.md`. |
| `tests/hidden/lib/grade.mjs` | the grader (one implementation; the private variants copy this folder's `tests/`) |
| `tests/hidden/lib/schema.json` | the grader's copy of the rubric schema (the same bytes) |
| `tests/hidden/grade.mjs` | turns one grader result into 9 checks and prints the score, the metric numbers and the diagnostics (CLI) |
| `tests/hidden/grade.test.ts` | one vitest case per check (the evaluator reads the vitest JSON report) |
| `tests/hidden/reference.json` | the reference judgment of the open variant |
| `tests/public/judgment-shape.test.ts` | shape only: one object, the 9 keys, `item_id` copied, the labels cover `shapes.json` |
| `solution/judgment.json`, `solution/solution.patch` | the reference and the patch that creates `out/judgment.json` |
| `fixtures/synthetic/` | a SUBAGENT unit whose BRIEF relays the human's message, with its reference (no corrections) |
| `fixtures/make-synthetic.mjs` | rebuilds the synthetic inputs with the contract's own builders (`--tools <dir>`); CI checks its outputs |
| `fixtures/grade.selftest.mjs` | the grader self-test, with `--mutants` |
| `fixtures/denylist.mjs` | the denylist scan of this folder |
| `fixtures/check.mjs` | CI: runs all of the above |

## Hidden checks (9)

| Check | Kind | Pass rule (one item) |
|---|---|---|
| `schema` | gate | strict `rubric/schema.json`: required keys, no extra key, closed enums, a valid type/subtype pair, length limits; `item_id` = the `ITEM` id of `item.txt` |
| `intents_closed` | gate | the keys of `intent_labels` are exactly the shapes of `shapes.json`; every value is in the closed intent list |
| `risk_floor` | gate | every decision whose pointer window holds a layer-1 risk signal has `risk >= floor`. Window = for a message, the spans after it up to the next message; for a span, itself and the spans after it up to the next message; at most 5 spans |
| `speaker` | gate | every `evidence_pointer` names an event of `item.txt`. `decided_by = tainan`: a HUMAN turn (main) or the BRIEF when it relays a Tainan message (subagent). `agent`: an ASSISTANT turn or a span. `tainan+agent`: the unit has a Tainan voice (a HUMAN turn, or the BRIEF relay). A correction quote is a literal substring of the HUMAN turn it points at (whitespace and MarkdownV2 escapes ignored). A subagent run has 0 corrections. |
| `outcome_consistent` | gate | `landed` needs a merge (`merge_token`, `merge_call`), publish (`plan_publish`, or an `artifact` link with a write action) or deploy (`deploy_or_health_check`) signal in `layer1.json`; a unit with a merge signal is never `talk_only` |
| `class_match` | metric | `type` and `subtype` equal to the reference (value = the mean of the two) |
| `risk_match` | metric | on the decisions matched to the reference (pointers at most 2 events apart, one-to-one, tie-break by text overlap): risk within ±1 AND `decided_by` equal, share ≥ 0.80. No matched decision = no evidence |
| `intent_agreement` | metric | share of the shapes whose label equals the reference label ≥ 0.80; `other` is always a miss. No shape = no evidence |
| `corrections` | metric | recall ≥ 0.80 and precision ≥ 0.85 vs the reference (a match = ≥ 50 % longest-common-substring overlap with the reference quote); value = F1. No correction on either side = no evidence |

When a gate fails, every metric check fails too. **Score** = 0 when a gate fails; else 100 × the mean of the
metric values that have evidence (the bake-off score v2 rule). Decision recall and precision are printed as a
diagnostic and never scored (the bake-off decision matcher failed its calibration).

`node tests/hidden/grade.mjs --judgment <file> --item <item.txt> --layer1 <layer1.json> --shapes <shapes.json> --reference <reference.json>`
prints `{ pass, passed, total, score, gates, metrics, diagnostics, checks, result }`.

## Acceptance

Each variant scores 100 with its reference and 0 with a null answer (no output, and a schema-valid empty
skeleton). On a variant with no shape to label, the skeleton passes `intents_closed` and still scores 0, because
its type/subtype differs from the reference. The private builder runs this on all ten real variants.

## Validate

```bash
node benchmarks/dfl-session-decision-trajectory-extraction/fixtures/check.mjs
npx tsx scripts/check-tasks.mts
npm run cli -w @itera/evaluator -- --validate --task ../../benchmarks/dfl-session-decision-trajectory-extraction
```

## Versions

| Task version | Grader | Why |
|---|---|---|
| 1 | 1.0.0 | First version (contract: schema_version 1, intent_list_version 1, taxonomy v2). |
