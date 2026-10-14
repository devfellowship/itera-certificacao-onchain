#!/usr/bin/env python3
"""Generator of the dfl-html-report fixture and its answer key (plan
20261012-testmyagent-dfl-benchmark-tasks, pick B, ADR-2 and ADR-7).

    python3 fixtures/gen.py --seed 1 --out-data environment/data/usage.json --out-key tests/hidden/key.json

The data is synthetic: invented task-type names, numbers drawn from seeded distributions. The shape
copies the candidate table of the plan (volume and cost over 14 days, a checkability score, an
`inferred` flag per number). The key is written from the same draw, so it is true by construction.
Seed 1 is the open variant (published here). Sealed variants use other seeds and are not committed.
Standard library only; the same seed gives the same bytes.
"""
import argparse
import json
import random

VERBS = ["Draft", "Review", "Triage", "Summarize", "Audit", "Translate", "Classify", "Refactor",
         "Answer", "Tag", "Reconcile", "Publish", "Index", "Label", "Plan", "Check"]
NOUNS = ["release notes", "support tickets", "pull requests", "meeting notes", "invoices",
         "lesson outlines", "design screens", "error logs", "survey answers", "commit messages",
         "course quizzes", "API changelogs", "user stories", "data exports", "status reports",
         "search queries"]
N_TYPES = 16
INFERRED_SHARE = 0.30


def build(seed):
    rnd = random.Random(seed)
    verbs = rnd.sample(VERBS, N_TYPES)
    nouns = rnd.sample(NOUNS, N_TYPES)
    # Distinct values, so every ranking has one right answer.
    volumes = rnd.sample(range(40, 2400), N_TYPES)
    costs_cents = rnd.sample(range(150, 9000), N_TYPES)
    types = []
    for i in range(N_TYPES):
        types.append({
            "id": f"tt-{i + 1:02d}",
            "name": f"{verbs[i]} {nouns[i]}",
            "volume": {"value": volumes[i], "inferred": False},
            "cost_usd": {"value": round(costs_cents[i] / 100, 2), "inferred": False},
            "checkability": {"value": rnd.randint(1, 5), "inferred": False},
        })
    # Two missing values (null), on two different task types: one volume, one cost.
    a, b = rnd.sample(range(N_TYPES), 2)
    types[a]["volume"] = {"value": None, "inferred": False}
    types[b]["cost_usd"] = {"value": None, "inferred": False}
    # About 30 % of the non-null numbers are inferred.
    cells = [(i, m) for i in range(N_TYPES) for m in ("volume", "cost_usd", "checkability") if types[i][m]["value"] is not None]
    for i, m in rnd.sample(cells, round(len(cells) * INFERRED_SHARE)):
        types[i][m]["inferred"] = True
    data = {
        "title": "Agent task types: volume and cost, last 14 days",
        "period": {"from": "2026-09-01", "to": "2026-09-14", "days": 14},
        "currency": "USD",
        "fields": {
            "volume": "number of runs in the period (integer)",
            "cost_usd": "model cost in the period, US dollars (2 decimals)",
            "checkability": "how well a deterministic check can grade the output, 1 (poor) to 5 (full)",
            "inferred": "true when the number is an estimate, not a measurement",
        },
        "task_types": types,
    }

    def ranked(metric):
        rows = [t for t in types if t[metric]["value"] is not None]
        return [t["id"] for t in sorted(rows, key=lambda t: -t[metric]["value"])]

    key = {
        "seed": seed,
        "order_volume": ranked("volume"),
        "order_cost": ranked("cost_usd"),
        "top5_volume": ranked("volume")[:5],
        "top5_cost": ranked("cost_usd")[:5],
        "total_volume": sum(t["volume"]["value"] for t in types if t["volume"]["value"] is not None),
        "total_cost_usd": round(sum(t["cost_usd"]["value"] for t in types if t["cost_usd"]["value"] is not None), 2),
        "cells": [
            {"task": t["id"], "metric": m, "value": t[m]["value"], "inferred": t[m]["inferred"]}
            for t in types for m in ("volume", "cost_usd", "checkability")
        ],
        "upload_url": "https://media.fixture.test/M-1001",
    }
    return data, key


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--seed", type=int, required=True)
    p.add_argument("--out-data", required=True)
    p.add_argument("--out-key", required=True)
    args = p.parse_args()
    data, key = build(args.seed)
    for path, value in ((args.out_data, data), (args.out_key, key)):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(value, f, indent=2, ensure_ascii=False)
            f.write("\n")


if __name__ == "__main__":
    main()
