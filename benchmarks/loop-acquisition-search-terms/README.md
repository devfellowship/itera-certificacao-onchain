# loop-acquisition-search-terms — negative keyword proposals

A synthetic benchmark for a loop agent such as `loop-acquisition`. The agent reads a fixture
search-terms report (`environment/data/search-terms.json`, invented shop, no real Ads data) and
writes `out/proposals.json`: the terms to add as negative keywords. It needs no MCP server.

| Path | What |
|---|---|
| `task.json`, `instruction.md` | the contract and the prompt |
| `environment/` | the agent workspace: the report (18 terms), vitest |
| `tests/public/` | file-shape checks |
| `tests/hidden/grade.mjs`, `proposals.test.ts` | the grader and its 7 hidden checks |
| `solution/` | the reference proposals and their patch |
| `fixtures/build.mjs` | writes the report and the reference solution |
| `fixtures/check.mjs` | CI: reproducibility, grader behaviour on 9 bad variants, denylist |

## Checks (hidden suite)

1. `shape`: a `proposals` array, each item with `term`, `action: add_negative_keyword` and a `reason`.
2. `terms-exist`: every proposed term is a row of the report (case and surrounding spaces ignored).
3. `no-converting-term`: no term with `conversions` above 0, fractional ones included.
4. `no-zero-spend-term`: no term with `cost_micros` 0.
5. `no-duplicates`.
6. `recall`: every term with `conversions` 0 and `cost_micros` above 0 is proposed (8 of 18).
7. `reason-cites-evidence`: each reason is a sentence that names the clicks or the cost of its own row.

PASS needs every check. Decoys: a term next to a converting term (`trail running shoes size guide`),
a fractional conversion (`tent footprint`, 0.5), and zero-cost zero-conversion rows.

## Rebuild

```bash
node fixtures/build.mjs
node fixtures/check.mjs
```
