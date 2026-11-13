# research-codebase: find the function

A synthetic benchmark for the routine that costs the most in agent sessions: researching a code base.
The agent reads a small invented backend (`environment/repo/`, 11 files) and answers 8 questions that
describe a function without naming it. The answer is `path:line`, a line inside the function.
It needs no MCP server and the grader is deterministic.

| Path | What |
|---|---|
| `task.json`, `instruction.md` | the contract and the prompt |
| `environment/` | the agent workspace: the fixture repo, `data/questions.json`, vitest |
| `tests/public/` | file-shape checks |
| `tests/hidden/grade.mjs`, `answers.test.ts`, `truth.json` | the grader, its 11 hidden checks and the function spans |
| `solution/` | the reference answers and their patch |
| `fixtures/build.mjs` | writes the fixture repo, the questions, the spans and the reference solution |
| `fixtures/check.mjs` | CI: reproducibility, grader behaviour on bad variants, denylist |

## Checks (hidden suite)

1. `shape`: an `answers` array, each item with an `id` and an `answer` of the form `path:line`.
2. `no-duplicates`: one answer per question.
3. `known-ids`: no id that is not a question.
4. `q1` to `q8`: the file is exactly right (a `./` or `repo/` prefix and spaces are ignored) and the line
   is inside the function, from its declaration line to its closing brace, both included.

PASS needs every check. `grade()` also returns `score`, the share of questions answered right, so a
cheaper model can be compared on more than pass or fail. Decoys: `applyCoupon` and `calculateTax` also
exist in `src/orders/legacy/pricing.ts`, a deprecated copy that the current code does not use.

The spans are computed from the fixture source by `build.mjs`, never typed by hand.

## Rebuild

```bash
node fixtures/build.mjs
node fixtures/check.mjs
```
