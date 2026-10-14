# dfl-html-report — HTML report from data, delivered to a media host

Pick B of plan [`20261012-testmyagent-dfl-benchmark-tasks`](https://plans.devfellowship.com/20261012-testmyagent-dfl-benchmark-tasks) (K4).
A real, frequent DFL job in synthetic form: turn usage data into one self-contained dark HTML
report, mark what is inferred, and deliver the file through an upload tool.

| Path | What |
|---|---|
| `task.json`, `instruction.md` | the contract and the prompt |
| `environment/` | the agent workspace: `data/usage.json` (16 task types, 14 days), vitest |
| `tests/public/` | file-shape checks, no browser (they run in the agent sandbox too) |
| `tests/hidden/report.test.ts` | 20 deterministic checks, run in the `chromium-axe` grader image (`verifier.image`) |
| `tests/hidden/key.json` | the answer key, written by the generator |
| `tests/hidden/mcp/media/assert.json` | 7 `mcp_state` assertions on the final state of `media@1` |
| `mcp/media/seed.json` | an empty media store |
| `solution/` | the reference report as a patch, and its one `upload_file` call |
| `fixtures/gen.py` | the seeded generator of the data and the key (`--seed N`) |
| `fixtures/build-solution.mjs` | builds the reference report, the patch and the replay calls from the data |

## Checks (hidden suite)

Gate-like checks first, then the scored ones. PASS needs every check and every `mcp_state`
assertion (ADR-5, ADR-11).

1. Document: `<!doctype html>` and `<meta charset="utf-8">` in the first 1024 bytes, at most 1 MB.
2. Self-contained (static): no `<script src>`, no stylesheet link, no external `src`, no `@import` / remote `url(`, no `fetch` / `XMLHttpRequest` / `WebSocket`.
3. Self-contained (runtime): zero non-local requests while the page loads.
4. MOUNT, NO ERRORS, CONTROL (the three render assertions of `verify-render`): visible text, zero `pageerror` at 1280 px and 390 px, at least 16 visible bars.
5. Numbers: every non-null value is in its table cell; `null` shows `no data` and has no bar; the totals match.
6. Order: top 5 by volume and by cost; the full order; bar widths never grow down the ranking.
7. Inferred marks: every inferred cell has the class `inferred` and a visible marker; no measured cell has either.
8. Dark background; axe-core `color-contrast` with zero serious violations at 1280 px and 390 px; no horizontal scroll at 390 px.
9. `out/result.json` names `https://media.fixture.test/M-1001` and the sha256 of `out/report.html`.

`mcp_state` (`media@1` export): exactly one file, `M-1001`, live, `text/html`, `private`, one
`upload_file` call, no `delete_file`.

## Rebuild

```bash
python3 fixtures/gen.py --seed 1 --out-data environment/data/usage.json --out-key tests/hidden/key.json
node fixtures/build-solution.mjs
```

Seed 1 is the open variant. Sealed variants use other seeds and are not committed (ADR-7).

## Known gaps (this round)

- The `mcp_state` scorer cannot compare the uploaded `sha256` with the file in the workspace: an
  assertion holds a constant, and the agent's report bytes vary. The hidden test checks that
  `out/result.json` holds the sha256 of the file; the export sha256 is not cross-checked yet. Needs
  a runner-side assertion form (for example `equals_workspace_sha256`).
- The upload passes the whole HTML as one tool argument. The model must repeat the file byte for
  byte, so a long report costs its output tokens twice.
