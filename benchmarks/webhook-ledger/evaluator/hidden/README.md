# Evaluator-only hidden tests — `webhook-ledger`

`hidden.test.ts` never ships inside the agent's sandbox export (see `benchmarks/README.md` for
the export boundary). It imports the fixture's own `src/` by relative path, so it must run from
a process that has both `fixture/` and `evaluator/hidden/` checked out side by side — which is
true for any reviewer or evaluator with access to this monorepo, but never true for the agent's
isolated workspace (which receives only the `fixture/` subtree).

**Planned runner mechanics (T11, not implemented yet):** after the agent's patch to `fixture/` is
frozen, the evaluator copies `evaluator/hidden/hidden.test.ts` into a path `fixture/` can resolve
(e.g. `fixture/tests/hidden.test.ts`) or runs it directly against the frozen `fixture/` checkout
with `fixture/`'s own `node_modules` on the path, then records pass/fail per check into the
evidence manifest. Until the real runner exists, run it manually from this folder structure with
`fixture/`'s dependencies installed:

```bash
cd benchmarks/webhook-ledger/fixture
npm install
npx vitest run ../evaluator/hidden/hidden.test.ts
```
