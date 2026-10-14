# repos@1 — a read-only fleet of real synthetic git repositories

Catalog fixture server for research tasks (first user: `benchmarks/dfl-fleet-research`).
Contract: `docs/architecture/mcp-sandbox.md`, "The fixture-server contract".

## The choice (ADR-8, TMA-Q2 = A)

**Upstream servers, not a custom MCP.** The plan named two options: wrap the existing
`modelcontextprotocol/servers` filesystem and git servers if their read tools fit, else write a
small MCP of 6 read tools. The evidence:

| Need of a research task | Upstream tool | Fit |
|---|---|---|
| list orgs and repos | `list_directory`, `directory_tree` on `/repos` and `/repos/<org>` | yes |
| list files of a repo | `directory_tree`, `list_directory` | yes |
| read a file | `read_text_file` (`head`/`tail`), `read_multiple_files` | yes |
| find files by name | `search_files` (glob, relative to `path`: `**/*.yml`, not `*.yml`) | yes |
| commit history | `git_log`, `git_show` (mcp-server-git) | yes |
| search file CONTENT (grep) | none | **gap** |
| line numbers in a read | none (raw text) | **gap** |

The two gaps are accepted. They are what a real agent meets with these widely used servers, and a
task with a small fleet (~14 repos, a few files each) stays solvable by listing and reading. A
task that cites `repo:path:line` must say that the agent counts the lines itself. If a campaign
shows that the gaps dominate the failures, `repos@2` can add a content-search tool.

## How it works

- **Seed** (`seed_schema` in `manifest.json`): `orgs[].repos[].commits[]`, each commit with an
  author, an ISO date and `files` (`path → content`, `null` = delete). `fleet.mjs` turns it into
  **real git repos** with `git fast-import`, then checks out `HEAD`. The dates and authors come
  from the seed, so the commit SHAs are the same on every boot.
- **Layout.** The agent sees `/repos/<org>/<repo>/` (a symlink to the `/state` tmpfs). The git
  directories live outside that tree (`--separate-git-dir`), so each repo has a one-line `.git`
  file and `directory_tree` stays small.
- **Upstreams** run as stdio child processes, started at boot (the server is `ready` only when
  both answer, and a drifted tool definition stops the boot with exit 4):
  - `@modelcontextprotocol/server-filesystem@2026.8.31` (Node), allowed directory `/repos`;
  - `mcp-server-git==2026.8.18` (Python, locked with hashes in `requirements.txt`),
    `--repository /repos`: its `validate_repo_path` refuses a `repo_path` outside `/repos`.
- **Read only.** `tools.json` lists only read tools. The write tools of both upstreams
  (`write_file`, `edit_file`, `move_file`, `git_commit`, `git_add`, ...) are not in `tools.json`,
  so the base refuses them like any unknown tool.
- **Export** (`/itera/export`, for the `mcp_state` scorer): the HEAD SHA of each repo plus the
  **read log** — `files_read` (`id` = `org/repo:path`), `dirs_listed`, `searches`, `git`, call
  counts. Only successful calls on real files count. Example assertion:
  `{ "path": "$.files_read[?(@.id=='acmehq/acme-player:README.md')]", "exists": true }`.

## Known upstream quirks (seen in the probe, 2026-10-14)

- `git_show` prints the date as a Python `repr` with a memory address
  (`tzoffset object at 0x7f...`). The tool OUTPUT is not byte-stable; the export is.
- `git_log` accepts relative dates (`2 weeks ago`), which depend on the wall clock.
- `list_allowed_directories` shows both `/repos` and its real path `/state/repos`.
- `search_files` matches a glob relative to `path`: `*.md` at `/repos` finds nothing.

## Test

```bash
docker build -t testmyagent-mcp-repos:dev -f mcp/catalog/repos/Dockerfile mcp
node mcp/conformance.mjs repos testmyagent-mcp-repos:dev
```
