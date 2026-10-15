-- 0018_users_principal.sql — account state of the web2 principals ("Login with DFL"), task T5 of
-- plan 20261015-testmyagent-web2-client (ADR-2, ADR-3, ADR-9).
--
-- Adds:
--   users   one row per `dfl` principal. `principal_id` is `dfl:<uuid>`, the same string the `*_wallet`
--           columns hold for that principal (ADR-3). `dfl_user_id` is the DFL Supabase Auth user id.
--           `iam_level` is the DFL IAM level read at the last login when TMA_MIN_IAM_LEVEL > 0 (else
--           null). `disabled = true` refuses the principal (403 account_disabled).
--           SIWS principals (web3) have no row here: their wallet is the whole account.
--
-- Same posture as 0000–0017: RLS on, no policies, grants to itera_api_service. No DB function, no
-- trigger (the API writes last_login_at in its upsert). Apply by hand on the TestMyAgent Supabase
-- project, in one transaction. Idempotent.

begin;

create table if not exists public.users (
  principal_id   text primary key check (principal_id like 'dfl:%'),
  dfl_user_id    uuid unique,
  email          text,
  iam_level      int,
  disabled       boolean not null default false,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

grant select, insert, update, delete on public.users to itera_api_service;
alter table public.users enable row level security;

commit;
