# trajectory-shapes/1

One rules spec for trajectory shapes (plan `20261112-tma-c9-trajectory-analytics`, task T3, ADR-3 and ADR-6).
This folder holds rules and synthetic fixtures only. It holds no run data.

| File | What it is |
|---|---|
| `spec.json` | The single source of the rules: the alphabet, the step-kind and intent tables, the tool fallback, the kind string, the shape rules, the path map pruning and the first-failure rule. |
| `fixtures.json` | Golden cases (`cases`: steps → kind string, truncated, shape, first failure; `path_map_cases`: kind strings → pruned nodes). Every consumer must pass all of them. |
| `check_fixtures.py` | The Python 3 reference implementation (stdlib only). `python3 -I check_fixtures.py` exits 0 when all cases pass, 1 otherwise. |
| `../trajectory-shapes.js` | The TypeScript/JS implementation: `kindOfStep`, `kindString`, `shapeOf`, `firstFailure`, `pathMap`, `TRAJECTORY_SHAPES_SPEC`. It reads every table from `spec.json`. |

## The two consumers

1. **Studio S9 (C5-T9)**, TypeScript, on TMA runs. The steps come from `tma-trajectory/2` and use
   `kind_source: "step_kind"`. The step kinds come from `../step-kind.js` (C4-T10).
2. **The fleet snapshot (C9-T4)**, Python, in `session-trajectory` `analytics/build.py` (repo `internal-skills`).
   The steps come from the layer-1 fleet intents and use `kind_source: "intent"`. That builder vendors
   `spec.json`, `fixtures.json` and the logic of `check_fixtures.py`.

## The gate result and the fallback

The C9-T2 spike (2026-11-13) ran the gate on 478 declared fleet runs. The gate failed: there were 0 fail labels in
269 labeled runs (the fleet outcome "PR merged / closed / reverted" is almost always "merged"), tool-storm had n=3
and search-first had n=2. The gate needs a spread of at least 15 points and n ≥ 20 per shape.

So the spec declares `"named_shapes": false` and `"fallback": "wall-only"` (plan ADR-6): the screens show the wall
alone. **A consumer MUST NOT label runs by shape while `named_shapes` is false.** The four shape rules stay in the
spec for a later re-run of the gate, when a richer outcome exists.

## Known limit

`first_failure` reads the step `ok` flag. An MCP tool that returns an error payload with a success status counts as ok.

## Change rule

A rule change = a version bump of `schema` (`trajectory-shapes/2`) + new fixtures. Both sides follow: the TypeScript
test (`../trajectory-shapes.test.ts`, which also runs the Python checker when `python3` is on PATH) and the vendored
copy in the fleet snapshot. Do not change a table in code: change `spec.json`.
