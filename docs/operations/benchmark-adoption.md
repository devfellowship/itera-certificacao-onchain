# Adopt historical benchmark runs

`services/runner/src/bench-adopt.ts` links an explicit historical campaign to an existing account.
Use the worker's existing `itera_api_service` database connection. This operation creates no run.
Deploy the API historical-result guard before an apply. Otherwise, the issuer can retry an imported infrastructure failure.

Prepare a non-secret JSON manifest with:

- `email` and `owner`: the existing account email and exact principal ID.
- `expectedRuns`: the exact number of runs across the selected packs.
- `agentIds` and `campaigns`: closed lists from the original campaign records.
- `packs`: `{ id, name, description, versions: [{ version, contract }] }`.
  Supply every registered pack version. Use each version's actual historical task contract.
  Do not substitute the latest contract for an older version.

Preview inside the runner container:

```sh
npx tsx services/runner/src/bench-adopt.ts --manifest /path/to/scope.json
```

The preview performs all checks and inserts, then rolls back the entire transaction.
Add `--apply` only after the preview matches the expected scope and the API guard is deployed.
Run the preview again after the apply. It must report zero inserted evaluations and every run already linked.

The operation refuses conflicting owners, task versions, existing evaluation links, unexpected campaigns,
unexpected agents, a changed run count, or a nonterminal run. A transaction and row locks protect the scope.
Each original run gets one evaluation, with the same UUID. The task item records `historicalRunId`.
The API uses this marker to prevent automatic retries. Its event log identifies the historical import.
Infrastructure errors stay in review. Invalid and timeout results do not receive an evaluation score.
The original run status and score remain unchanged.

Tasks are private owned catalog packs. Their versions keep the registered fixture and criteria digests.
Agents keep their original connector, file snapshots, model, repository fields and visibility.
The owner can read an endpoint agent through the agent list and profile. GitHub mutation routes stay GitHub-only.
The web2 task editor shows an owned catalog pack as a read-only snapshot.

Before and after the apply, compare a digest of every run field except the five links:
`owner_wallet`, `evaluation_id`, `task_id`, `task_version_id`, and `seq`.
Also verify the expected task, version, agent and evaluation counts through the authenticated account views.
Do not upload account manifests or database rows to public artifact storage.
