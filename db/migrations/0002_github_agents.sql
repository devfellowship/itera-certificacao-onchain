-- 0002 — GitHub App agent connector (lane C, plan 20261012-itera-agent-proof-route-change-fixes, ADR-2).
-- Target: the itera-hackatoon Supabase project. Idempotent (safe to re-run). No DB functions/triggers:
-- all logic lives in apps/api (src/http/github-router.ts).

-- One row per GitHub App installation, bound to the wallet that completed the install flow.
create table if not exists public.github_installations (
  installation_id bigint primary key,
  owner_wallet    text not null,
  account_login   text,
  created_at      timestamptz not null default now()
);
create index if not exists github_installations_owner_wallet_idx on public.github_installations (owner_wallet);

-- Agents gain an owner (wallet) and the GitHub source. Legacy endpoint agents keep connector='endpoint'.
alter table public.agents add column if not exists owner_wallet       text;
alter table public.agents add column if not exists gh_installation_id bigint;
alter table public.agents add column if not exists repo_full_name     text;
alter table public.agents add column if not exists agent_path         text default '.';
alter table public.agents add column if not exists model              text;
alter table public.agents add column if not exists connector          text not null default 'endpoint';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agents_connector_check') then
    alter table public.agents add constraint agents_connector_check check (connector in ('endpoint', 'github'));
  end if;
end $$;
create index if not exists agents_owner_wallet_idx on public.agents (owner_wallet);

-- A pinned snapshot of the agent files (AGENTS.md, CLAUDE.md, skills/**) at one commit.
-- files = [{ "path": "AGENTS.md", "sha": "<blob sha>", "size": 123, "encoding": "utf-8"|"base64", "content": "..." }]
-- (paths relative to agents.agent_path). The API caps the total at 200 KB.
create table if not exists public.agent_versions (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid not null references public.agents (id) on delete cascade,
  commit_sha text not null,
  files      jsonb not null,
  created_at timestamptz not null default now(),
  unique (agent_id, commit_sha)
);
create index if not exists agent_versions_agent_created_idx on public.agent_versions (agent_id, created_at desc);
