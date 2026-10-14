# media@1 — stateful fake of a media host

A catalog fixture server (contract: `docs/architecture/mcp-sandbox.md`). It simulates a file host
such as a report/asset uploader. No open MCP server fits this shape, so this is a small fake in the
shape of `helpdesk@1` (plan `20261012-testmyagent-dfl-benchmark-tasks`, ADR-8).

| Tool | Effect |
|---|---|
| `upload_file` | Stores the bytes (`content` as UTF-8 text, or `content_base64`) in the sidecar tmpfs. Returns `id` (`M-<ITERA_MCP_ID_SEED + n>`), `url` (`https://media.fixture.test/<id>`), `sha256`, `size`, `content_type`, `media_type`, `visibility`, `created_at`. `visibility` is required: `private`, `members` or `public`. |
| `get_file_meta` | Metadata of one file by id. Never the content. |
| `delete_file` | Marks the file deleted and removes its bytes. Ids are never reused. |

**Seed:** `{ "files": [] }` — an empty store, or up to 50 pre-existing text files (`id` `M-<n>`).

**Export** (`/itera/export`, for the `mcp_state` scorer): `{ "files": [...] }` sorted by id, every
file ever stored, deleted ones included with `deleted: true` and `deleted_at`. The bytes are not
exported: a scorer compares `sha256` with the file in the workspace. Example assertions:

```json
[
  { "path": "$.files[?(@.deleted==false)]", "count": 1 },
  { "path": "$.files[?(@.deleted==false)].media_type", "equals": "text/html" },
  { "path": "$.files[?(@.deleted==false)].visibility", "equals": "private" },
  { "calls": "upload_file", "max": 1 }
]
```

**Limits:** the HTTP body limit of `mcp/base` is 1 MiB per request, so one upload is at most about
900 kB of text or about 750 kB of binary (base64). The store holds at most 16 MiB.

Build and test: `docker build -f catalog/media/Dockerfile mcp -t testmyagent-mcp-media:ci && node mcp/conformance.mjs media testmyagent-mcp-media:ci`.
