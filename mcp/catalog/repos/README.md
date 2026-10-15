# repos@2 — a read-only fleet of real synthetic git repositories

Catalog fixture server for research tasks (users: `benchmarks/dfl-fleet-research`).
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
| line numbers in a read | none (raw text) | **gap in repos@1, closed in repos@2** |

The first gap (content search) stays. The second gap did not stay: in campaign `k7-dfl-bench-1`
the agents that had to cite `repo:path:line` counted the lines themselves and cited a line that was
off by 2 (they cited line 11 for text on line 13). Tainan, TMA-QA = C (TG 21527): give the agent a
read tool WITH line numbers and keep the strict evidence rule in the task.

## repos@2: what changed since repos@1

`repos@1` is published and never changes (tasks pin its digest). `repos@2` is a new version of the
same directory: the same 8 tools, plus one:

| Tool | What it does |
|---|---|
| `read_file_lines { path, start?, end? }` | Returns the file, or the lines `start..end` (1-based, inclusive), as `  42\| text`. `end` past the last line is clamped. More than 1000 lines in one call are cut and the output says where to go on. An empty file or a `start` past the end is an error that gives the line count. |

- **Our own tool, not an upstream tool.** The upstream `read_text_file` is unchanged, so the drift
  check against `tools.json` still holds for the 8 upstream tools. `read_file_lines` is served by
  `server.mjs` (the pure line arithmetic is in `lines.mjs`, tested by `lines.test.mjs`) and is listed in
  `manifest.json` `local_tools`.
- **One definition of a line.** Split on `\n`; a final `\n` does not open an extra line; the first line
  is 1. This is the definition the task graders use (`text.split('\n')`).
- **Same reach as the filesystem server:** a regular file under `/repos`. `.git` entries are refused.
- **Read log.** Every `files_read` entry has a new field `lines`: the merged line ranges the agent has
  seen in that file, for example `[[1, 12], [30, 41]]`. It is filled by `read_file_lines`, and also by
  `read_text_file` (`head`, `tail` or the whole file) and `read_multiple_files` (the whole file). The `mcp_state` scorer
  filters with `==` only, so today the field serves analysis of a run (did the agent see the line it
  cites?), not an assertion.
  The field is new; the fields of repos@1 are unchanged, so an assertion written for repos@1 still works.

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
  **read log** — `files_read` (`id` = `org/repo:path`, and the `lines` read), `dirs_listed`, `searches`, `git`, call
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
node --test mcp/catalog/repos/lines.test.mjs      # the line arithmetic, no Docker
```
