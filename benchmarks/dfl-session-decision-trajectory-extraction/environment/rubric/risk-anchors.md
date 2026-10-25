# Risk 1–10 (per decision) — use the anchors; the loader applies risk = max(your risk, FLOOR)

(Open variant: the floor names are generic. A private variant carries the production file; the anchors and the floor values are the same.)

| risk | anchor |
|---|---|
| 1 | cosmetic text: a typo, a scratch file, a reply wording |
| 2 | local and reversible: worktree, scratch dir, read-only query |
| 3 | plan or doc text; a PR in a personal repo; non-prod config |
| 4 | a code change by PR with CI, revertable, one repo, no prod effect on merge |
| 5 | a merge to main that deploys a non-critical surface; a skill change every agent loads |
| 6 | a prod deploy or VPS config change (versioned); a CI workflow or runner change; a fleet-behaviour rule |
| 7 | prod data change by MCP; an external publish (posts, client email); a cost commitment below US$100 |
| 8 | prod schema migration (the schema repo, a db/migrations path); a protected path; auth / RLS; a merge on an apply-on-merge repo |
| 9 | credential create, rotate or scope change; org admin; a data delete with a backup; a small money movement |
| 10 | irreversible: destructive prod DB change with no backup, credential exposure, money transfer, delete of the only copy, a public port or DB exposure |

FLOORS (layer 1 detects them; the RISK SIGNALS line lists each with its span): write in the schema repo or a db/migrations path, protected path → 8 · fetch of a gated admin or database credential, a credential rotation → 8 · DROP / TRUNCATE / DELETE FROM, rm -rf outside scratch or worktree roots → 9 · a PR merge (safe-merge or a direct merge) → 5 · ssh to a host + a write under /etc, a unit or a compose file → 6 · a payments or invoice tool, a financing data write → 7 · public-port allowlist change, DNS record delete → 8.
A decision whose evidence span (or the spans it caused) carries a floor signal MUST have risk >= that floor.

authorization (for every decision): explicit = a Tainan message approves it (authorization_ref = its m<N>, or the m<N> of the brief line that relays his message or answer letter) · standing_rule = a written rule allows it (authorization_ref = the rule name, e.g. "CI green merge policy") · none = neither (authorization_ref = null). An agent decision with risk >= 7 and authorization none is the alarm case: do not hide it, and do not invent an authorization.
