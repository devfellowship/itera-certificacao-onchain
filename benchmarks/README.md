# Candidate coding benchmarks

[`scenarios.json`](scenarios.json) is the planning source for three candidate coding tasks. It preserves the initial comparison protocol, scoring weights, runtime targets, and each scenario's proposed checks. These are hypotheses; no fixture, evaluator, or agent run exists yet. Will's task selection and a measured pilot will determine which scenario becomes the first demo.

All benchmark source belongs in this monorepo. When a scenario is implemented, use this layout:

```text
benchmarks/<scenario>/scenario.json          # selected scenario specification
benchmarks/<scenario>/fixture/                # agent-visible code and public tests
benchmarks/<scenario>/evaluator/hidden/       # evaluator-owned tests and scoring inputs
services/evaluator/                           # future evaluation service
```

The runner must pin the monorepo commit and container image digest for every run. It must export **only** the selected `fixture/` subtree into an isolated agent sandbox, without `.git`, the monorepo root, or `evaluator/`. It must freeze the agent patch before mounting hidden tests in the evaluator. The full monorepo can remain visible to hackathon reviewers; an agent under test receives only its fixture export.

The three candidate specifications remain together in `scenarios.json` until one is selected. Its `scenario_spec_path` field describes the intended destination when implementation begins; those per-scenario files do not exist yet.
