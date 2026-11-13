# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Itera / DevFellowship
"""Reference implementation of trajectory-shapes/1 (Python 3 stdlib only).

Loads spec.json and fixtures.json next to this file, runs every golden case and exits 0 (all pass) or 1.
The fleet snapshot builder vendors spec.json + fixtures.json + the functions below: every table comes from the
spec, so a rule change is a spec change (version bump + new fixtures), never a code-only change.

Usage: python3 -I check_fixtures.py [spec.json] [fixtures.json]
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def kind_of_step(spec, step):
    src, value = step["kind_source"], step["value"]
    if src == "step_kind":
        if value not in spec["step_kind_map"]:
            raise ValueError("unknown step_kind %r" % value)
        return spec["step_kind_map"][value]
    if src != "intent":
        raise ValueError("unknown kind_source %r" % src)
    fb = spec["tool_fallback"]
    if value in fb["applies_to"]:
        family, tool = step.get("family"), step.get("tool")
        if family in fb["family"]:
            return fb["family"][family]
        if tool in fb["tool"]:
            return fb["tool"][tool]
        return fb["default"]
    if value not in spec["intent_map"]:
        raise ValueError("unknown intent %r" % value)
    return spec["intent_map"][value]


def kind_string(spec, steps):
    full = "".join(kind_of_step(spec, s) for s in steps)
    cap = spec["kind_string"]["max_chars"]
    return {"kind_string": full[:cap], "truncated": len(full) > cap}


def runs_of(ks, letter):
    """(start, end) of every maximal run of letter, end exclusive."""
    out, i = [], 0
    while i < len(ks):
        if ks[i] == letter:
            j = i
            while j < len(ks) and ks[j] == letter:
                j += 1
            out.append((i, j))
            i = j
        else:
            i += 1
    return out


def rule_matches(rule, ks):
    name = rule["name"]
    if name == "test-loop":
        runs = runs_of(ks, rule["letter"])
        if len(runs) < rule["min_runs"]:
            return False
        return any(rule["between"] in ks[a[1]:b[0]] for a, b in zip(runs, runs[1:]))
    if name == "tool-storm":
        return any(e - s >= rule["min_run"] for s, e in runs_of(ks[:rule["window"]], rule["letter"]))
    if name == "search-first":
        return ks[:1] == rule["letter"]
    if name == "straight":
        return True
    raise ValueError("unknown shape rule %r" % name)


def shape_of(spec, ks):
    if ks == "":
        return spec["empty_shape"]
    for rule in spec["shape_rules"]:
        if rule_matches(rule, ks):
            return rule["name"]
    raise ValueError("no shape rule matched %r" % ks)


def first_failure(spec, steps):
    for i, s in enumerate(steps):
        if s["ok"] is False:
            last = spec["first_failure"]["start_token"] if i == 0 else kind_of_step(spec, steps[i - 1])
            return {"first_fail_seq": i, "first_fail_kind": kind_of_step(spec, s), "last_good_kind": last}
    return None


def collapse(ks):
    return "".join(ch for i, ch in enumerate(ks) if i == 0 or ks[i - 1] != ch)


def path_map(spec, kind_strings):
    p = spec["path_map_prune"]
    counts = {}
    for ks in kind_strings:
        path = collapse(ks) if p["collapse_repeats"] else ks
        for d in range(1, min(len(path), p["max_depth"]) + 1):
            counts[path[:d]] = counts.get(path[:d], 0) + 1
    total = len(kind_strings)
    keep = [k for k, n in counts.items() if n >= p["min_runs"] and n * 100 >= p["min_share_pct"] * total]
    return {"nodes": [{"path": k, "n": counts[k]} for k in sorted(keep)]}


def main(argv):
    spec = load(argv[1] if len(argv) > 1 else os.path.join(HERE, "spec.json"))
    fixtures = load(argv[2] if len(argv) > 2 else os.path.join(HERE, "fixtures.json"))
    failures = []
    if spec.get("schema") != "trajectory-shapes/1" or fixtures.get("schema") != spec.get("schema"):
        failures.append("schema mismatch")
    if sorted(list(spec["intent_map"]) + spec["tool_fallback"]["applies_to"]) != sorted(spec["layer1_intents"]):
        failures.append("intent_map + tool_fallback.applies_to != layer1_intents")
    if spec["named_shapes"] is not False:
        failures.append("named_shapes must stay false until the gate passes")
    for case in fixtures["cases"]:
        steps = case["input"]["steps"]
        ks = kind_string(spec, steps)
        got = dict(ks, shape=shape_of(spec, ks["kind_string"]), first_failure=first_failure(spec, steps))
        if got != case["expect"]:
            failures.append("case %r: got %s" % (case["name"], json.dumps(got)[:300]))
    for case in fixtures["path_map_cases"]:
        got = path_map(spec, case["kind_strings"])
        if got != case["expect"]:
            failures.append("path_map case %r: got %s" % (case["name"], json.dumps(got)))
    n = len(fixtures["cases"]) + len(fixtures["path_map_cases"])
    for f in failures:
        print("FAIL " + f)
    print("trajectory-shapes/1: %d cases, %d failed" % (n, len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
