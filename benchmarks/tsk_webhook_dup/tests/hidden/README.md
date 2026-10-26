# Hidden tests — `webhook-ledger`

These tests are the evaluator's. The agent workspace never contains them: the evaluator copies
`environment/` and `tests/public/` into the agent sandbox, and mounts `tests/hidden/` only in a
fresh grading container after the agent's patch is frozen. See `../../task.json` (the task
contract) and `services/evaluator/README.md`.

This directory is in a public repository, so the "hidden" property is custody by path, not
secrecy. The evidence manifest records it as a limitation.

Run them by hand against the golden solution:

```bash
cd benchmarks/webhook-ledger
tmp=$(mktemp -d) && cp -r environment/. tests "$tmp" && cd "$tmp"
npm ci && git init -q && git apply "$OLDPWD/solution/solution.patch"
npx vitest run tests/hidden
```
