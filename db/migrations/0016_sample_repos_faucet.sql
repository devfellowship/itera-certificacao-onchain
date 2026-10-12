-- 0016_sample_repos_faucet.sql — sample repos for any wallet + devnet faucet (U37, plan
-- 20261012-itera-testmyagent-ui-refactor, Tainan TG 21122/21126).
--
-- Adds:
--   agents.repo_source   'github' | 'sample'. 'sample' = the agent files were read from a sample repo
--                        through the TestMyAgent installation, not through an installation bound to
--                        the owner wallet. Null on rows written before this migration (the API
--                        derives the value from the sample allow-list then).
--   faucet_grants        one row per devnet SOL grant: one per wallet per 24 h, a global daily cap.
--                        'pending' and 'sent' rows count toward both limits; 'failed' rows do not.
--
-- Same posture as 0000–0015: RLS on, no policies, grants to itera_api_service. No DB functions, no
-- triggers (the API takes a transaction-scoped advisory lock to check the limits). Idempotent.

begin;

alter table public.agents add column if not exists repo_source text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agents_repo_source_check') then
    alter table public.agents add constraint agents_repo_source_check check (repo_source is null or repo_source in ('github', 'sample'));
  end if;
end $$;

create table if not exists public.faucet_grants (
  id            uuid primary key default gen_random_uuid(),
  wallet        text not null,
  lamports      bigint not null check (lamports > 0),
  status        text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  tx_sig        text,
  error         text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists faucet_grants_wallet_idx on public.faucet_grants (wallet, created_at desc);
create index if not exists faucet_grants_created_idx on public.faucet_grants (created_at desc);

grant select, insert, update, delete on public.faucet_grants to itera_api_service;
alter table public.faucet_grants enable row level security;

commit;
