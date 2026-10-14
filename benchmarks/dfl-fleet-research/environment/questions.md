# Questions about the Acme engineering fleet

The fleet has two GitHub-style orgs, `acme` and `acmehq`. Every repository is a real git repository
under `/repos/<org>/<repo>/`, and you can read it only through the `repos` MCP server.

- **q1.** Which repository holds the source code of **the Acme player** app? Answer `org/repo`.
- **q2.** Which workflow file applies the database migrations to **production** after a pull request
  merges? Answer `org/repo/path/to/workflow.yml`.
- **q3.** In `acme/acme-harness`, some skills duplicate another skill. Two skills are duplicates when
  their `purpose:` lines describe the same job; a similar name is not enough. Answer the list of
  duplicate pairs, for example `[["skill-a", "skill-b"]]`.
- **q4.** `acme/acme-infra/docs/ci-rules.md` has CI runner rules. Exactly one workflow file in the
  fleet breaks rule R1. Which one? Answer `org/repo/path/to/workflow.yml`.
- **q5.** The vault path of the payments API key is `vault:/payments/PAYMENTS_API_KEY`. Which files
  reference that exact path? Answer the list of `org/repo/path` values.
- **q6.** Which file defines the Helm chart that deploys `acme-services` to Kubernetes? Answer
  `org/repo/path`.
