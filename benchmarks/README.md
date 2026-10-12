# Candidate coding benchmarks

[`scenarios.json`](scenarios.json) is the planning source for three candidate coding tasks. It preserves the initial comparison protocol, scoring weights, runtime targets, and each scenario's proposed checks. These are hypotheses; no fixture, evaluator, or agent run exists yet. Will's task selection and a measured pilot will determine which scenario becomes the first demo.

All benchmark source belongs in this monorepo. When a scenario is implemented, use this layout:

```text
benchmarks/<scenario>/task.json               # the task contract (packages/contracts/schemas/task.schema.json)
benchmarks/<scenario>/instruction.md          # the agent prompt
benchmarks/<scenario>/environment/            # agent-visible code (workspace root)
benchmarks/<scenario>/tests/public/           # public tests, in the agent workspace
benchmarks/<scenario>/tests/hidden/           # evaluator-owned tests, grading container only
benchmarks/<scenario>/solution/solution.patch # reference solution, validation gate only
benchmarks/<scenario>/scenario.json           # planning view (optional)
services/evaluator/                           # generic verifier, see its README
```

The runner must pin the monorepo commit and container image digest for every run. It must export **only** `environment/` and `tests/public/` into an isolated agent sandbox, without `.git`, the monorepo root, `tests/hidden/` or `solution/`. It must freeze the agent patch before mounting hidden tests in the evaluator. The full monorepo can remain visible to hackathon reviewers; an agent under test receives only its fixture export.

The three candidate specifications remain together in `scenarios.json` until one is selected. Its `scenario_spec_path` field describes the intended destination when implementation begins; those per-scenario files do not exist yet.
