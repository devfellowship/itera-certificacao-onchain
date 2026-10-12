-- 0012_mcp_catalog.sql — the Itera MCP catalog (U29, ADR-11, plan 20261012-itera-testmyagent-ui-refactor;
-- design docs/architecture/mcp-sandbox.md "Registration flow", step 4).
--
-- One row per published version of a catalog server (mcp/catalog/<name>/ in this repo). The API
-- writes it: on boot and on a timer it reads manifest.json + tools.json at the deployed commit,
-- resolves ghcr.io/devfellowship/itera-mcp-<name>:<version> to its digest, and upserts the row.
-- The runner reads it to pin a task's `catalog: name@version` to an image digest. A version is
-- immutable once published (the CI job mcp-catalog refuses to push it twice), so the digest of a
-- row never changes after status = 'published'.
--
-- Same posture as 0000–0011: RLS on, no policies, the API connects as itera_api_service.
-- No DB function, no trigger: the sync lives in apps/api. Idempotent. One transaction.

begin;

create table if not exists public.mcp_catalog (
  name           text not null check (name ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  version        int  not null check (version between 1 and 999999),
  image          text not null,                       -- ghcr.io/devfellowship/itera-mcp-<name>
  image_digest   text check (image_digest is null or image_digest ~ '^sha256:[0-9a-f]{64}$'),
  status         text not null default 'unpublished' check (status in ('unpublished', 'published', 'retired')),
  transport      text not null check (transport in ('http', 'stdio')),
  capabilities   text[] not null default '{}',
  tools_snapshot jsonb not null,                      -- tools.json: the tools/list a task pins
  manifest       jsonb not null,                      -- manifest.json (seed_schema, resources, license, upstream)
  commit_sha     text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{7,40}$'),
  synced_at      timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  primary key (name, version),
  -- A published row always has its digest.
  constraint mcp_catalog_published_digest_check check (status <> 'published' or image_digest is not null)
);

comment on table public.mcp_catalog is
  'U29 / ADR-11: Itera MCP catalog servers by version. Synced by the API from mcp/catalog/*/manifest.json + GHCR digests.';

grant select, insert, update, delete on public.mcp_catalog to itera_api_service;
alter table public.mcp_catalog enable row level security;

commit;
