# ui-design-audit (task C of plan 20261012-testmyagent-dfl-benchmark-tasks)

A visual QA task on the `browser@1` catalog server (`mcp/catalog/browser/`, official Playwright
MCP). A small invented 3-screen app ("Northwind Ops": `list`, `detail`, `form`) runs at
`http://app.local` inside the sidecar. The design is given twice: full-page PNGs in
`environment/designs/` (1280 and 390 px) and the golden build as HTML at `http://design.local`
(Q7 option A: a text-only model compares DOM and computed styles; a vision model can use the PNGs).
The agent lists every discrepancy in `out/findings.json`.

## The variant (seed 1, open)

`fixtures/gen.mjs --seed N` picks **8 defects of 8 different types** from a catalog of 12
(padding, gap, text color, background color, font weight, font size, copy, missing icon,
swapped order, border radius, truncated label, height), at least 2 per screen, **2 of them only
at 390 px** (inside the `≤600px` media block). Both builds have the same structure and one CSS
rule per `data-testid`; only values differ, so the stylesheet does not reveal the defects.

Two **decoys**, named in the instruction as "do not report": the live `Updated hh:mm` clock (the
app shows the current time, the design 09:41), and a 0.4 px `margin-top` shift (below the 1 px rule).

## Grading (`tests/hidden/grade.mjs`, one vitest case per check)

| Check | Rule | Plan weight |
|---|---|---|
| `schema` | valid `out/findings.json`, at most 60 findings | gate |
| `recall` | ≥ 0.75 of the 8 defects found | 40% (hard gate) |
| `precision` | ≥ 0.70 of the findings match a defect | 25% (hard gate) |
| `values` | ≥ 0.75 of the found value defects state expected and actual right (hex ±2 per channel, px ±1, weight, exact copy) | 25% |
| `no-decoy-clock`, `no-decoy-subpixel` | zero reports on a decoy | 10% |
| `mcp_state` (`tests/hidden/mcp/browser/assert.json`) | every screen of `app.local` open at 1280 and at 390 px (`visits[].view`) | gate |

A finding matches a defect when the screen is the same, the category is one the defect accepts,
the viewport fits, and the selector's last `data-testid`/`#id` token names the element (or the
optional `bbox` overlaps it with IoU ≥ 0.3, from `tests/hidden/bboxes.json`).

## Files

- `fixtures/gen.mjs` — seed → `mcp/browser/seed.json` (both sites), `tests/hidden/key.json`,
  the coverage assertions, and the reference solution (`solution/`).
- `fixtures/render.mjs` — run in the `browser@1` image: the design PNGs, `bboxes.json`, and a
  check that every defect changes the pixels of its region (14/14 visible for seed 1).
- `fixtures/check.mjs` — CI: reproducible from the seed; the solution passes; the no-op, a decoy
  report, 3 dropped defects, wrong values and 5 invented findings each fail; denylist + secret scan.

## Rebuild

```bash
node fixtures/gen.mjs --seed 1
docker build -t testmyagent-mcp-browser:dev -f ../../mcp/catalog/browser/Dockerfile ../../mcp
docker run --rm -v "$PWD:/task" --user 0 -e TMPDIR=/tmp -e HOME=/tmp --entrypoint node testmyagent-mcp-browser:dev /task/fixtures/render.mjs
node fixtures/check.mjs
```
