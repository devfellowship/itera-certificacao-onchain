#!/usr/bin/env python3
"""Check candidate scenario structure and the agent/evaluator path boundary."""

import json
from pathlib import Path


root = Path(__file__).resolve().parents[1]
data = json.loads((root / "benchmarks/scenarios.json").read_text(encoding="utf-8"))
scenarios = data["scenarios"]
assert len(scenarios) == 3, "expected exactly three candidate scenarios"
assert len({s["id"] for s in scenarios}) == len(scenarios), "duplicate scenario ID"
assert sum(data["shared_protocol"]["score_100"].values()) == 100, "score must total 100"

budget = data["shared_protocol"]["runtime_budget_seconds"]
assert sum(value for key, value in budget.items() if key != "total") == budget["total"], "runtime budget total differs from its parts"

for scenario in scenarios:
    scenario_id = scenario["id"]
    assert scenario_id and all(c.islower() or c.isdigit() or c == "-" for c in scenario_id), "unsafe scenario ID"
    shape = scenario["repo_fixture_shape"]
    base = f"benchmarks/{scenario_id}"
    assert shape["repository"] == "devfellowship/itera-certificacao-onchain", "scenario points to another repository"
    assert shape["fixture_path"] == f"{base}/fixture", "fixture path differs from the export boundary"
    assert shape["hidden_test_path"] == f"{base}/evaluator/hidden", "hidden tests must stay outside fixture"
    assert shape["scenario_spec_path"] == f"{base}/scenario.json", "scenario spec path differs from layout"
    assert scenario["public_checks"] and scenario["hidden_checks"], "both public and hidden checks are required"

print("Three candidate scenarios and the monorepo sandbox boundary are valid.")
