# `tma eval` example: `tsk_webhook_dup`

A replay case on the curated task `tsk_webhook_dup` and two patch variants (no model, no key):

```bash
cd services/runner
npm run tma -- eval case --case examples/eval/tsk_webhook_dup/case.json --dest /tmp/case-webhook
npm run tma -- eval run --case /tmp/case-webhook --variant examples/eval/tsk_webhook_dup/solution.variant.json --repeat 3
npm run tma -- eval run --case /tmp/case-webhook --variant examples/eval/tsk_webhook_dup/empty.variant.json --repeat 3
npm run tma -- eval diff /tmp/case-webhook/runs/<baseline sha12> /tmp/case-webhook/runs/<variant sha12>
```

The reference solution passes the `hidden-tests` grader (score 100) on each run. The empty output fails the
hard gate (score 0). The grader version in `case.json` is the evaluator version (`hidden-tests@0.3.0`).
