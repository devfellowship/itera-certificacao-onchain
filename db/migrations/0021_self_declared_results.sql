-- 0021_self_declared_results.sql — self-declared local results, local agents, tenant-scoped custom
-- models and CLI device codes (plan 20261026-tma-local-runner-and-self-declared-results, §5, ADR-2,
-- ADR-4, ADR-5, ADR-7, ADR-8; task L2).
--
-- Adds:
--   evaluations.result_origin, runs.result_origin
--                       'hosted' (TMA ran it: the hosted worker) | 'self_declared' (the owner ran it on
--                       his own machine and sent only the numbers through POST /self-declared-results).
--                       TMA does not attest a self-declared result: no proof, no "verified".
--   payment_kind 'none' the payment kind of a self-declared evaluation (no fee, no payment, no key).
--                       A CHECK keeps the pair exact: payment_kind = 'none' <=> result_origin =
--                       'self_declared', and a 'none' row has no payment_id. A second CHECK keeps a
--                       self-declared evaluation private (is_public = false): plan Q4 = C, owner only.
--   agents.connector 'local'
--                       an agent with no repo and no files (POST /agents/local). It cannot start a hosted
--                       evaluation (the API answers 409 agent_is_local).
--   agents.provider_key, agents.route_key
--                       the declared lab and route (keys of packages/contracts/model-catalog/). Null = the
--                       UI derives them from the model id, as before.
--   task_versions.source 'local' + task_versions.contract_digest
--                       a private task folder on the owner's disk. Only its digests are stored
--                       (contract_digest, fixture_digest = environment, hidden_digest = hidden tests).
--   user_models         custom models of ONE principal (the tenant). Never read by GET /models, the
--                       model sync or the public ranking. At most 50 per owner (the API enforces it).
--   cli_device_codes    the device login of the local CLI (tma login). The device code is stored only
--                       as its sha256. One code works once; it expires after 600 s. Task L5 adds the
--                       states that the API needs: denied_at (the user clicked Deny), polled_at (the
--                       poll interval), client_name (shown on the approve page), session_id (the `sid`
--                       claim of the CLI session, set when the CLI takes its token) and revoked_at
--                       (the owner revoked that CLI session under GET /me/cli-sessions).
--
-- DATA CHANGE (the only one): the rows that services/runner/src/bench-import.ts wrote (the bake-off of
-- 2026-10-24/25) become self-declared, because TMA did not run them. The rule is deterministic and
-- idempotent: runs.provenance->>'source' = 'bench-import'. TMA has no data API for this relabel.
--
-- Same posture as 0000–0020: RLS on, no policies, grants to itera_api_service (the role the API and the
-- runner both connect as). No DB functions, no triggers: the logic stays in apps/api. Idempotent: safe
-- to run twice. Applied by hand on the TestMyAgent Supabase project, in one transaction, AFTER the API
-- that reads payment_kind 'none' is deployed (plan Q5, task L12).

begin;

-- ---------------------------------------------------------------------------------------------
-- result_origin on evaluations and runs
alter table public.evaluations add column if not exists result_origin text not null default 'hosted';
alter table public.runs        add column if not exists result_origin text not null default 'hosted';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'evaluations_result_origin_check') then
    alter table public.evaluations add constraint evaluations_result_origin_check
      check (result_origin in ('hosted', 'self_declared'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'runs_result_origin_check') then
    alter table public.runs add constraint runs_result_origin_check
      check (result_origin in ('hosted', 'self_declared'));
  end if;
end $$;

comment on column public.evaluations.result_origin is
  'hosted = TMA ran it (the hosted worker); self_declared = the owner ran it locally and sent only the numbers. TMA does not attest a self-declared result.';
comment on column public.runs.result_origin is
  'Same as evaluations.result_origin, per run.';

-- ---------------------------------------------------------------------------------------------
-- payment_kind 'none' (0019 had solana_pay | free_byok)
alter table public.evaluations drop constraint if exists evaluations_payment_kind_check;
alter table public.evaluations add constraint evaluations_payment_kind_check
  check (payment_kind in ('solana_pay', 'free_byok', 'none'));

do $$
begin
  -- A self-declared evaluation, and only a self-declared one, has payment_kind 'none' and no payment.
  if not exists (select 1 from pg_constraint where conname = 'evaluations_self_declared_payment_check') then
    alter table public.evaluations add constraint evaluations_self_declared_payment_check
      check (
        (payment_kind = 'none') = (result_origin = 'self_declared')
        and (payment_kind <> 'none' or payment_id is null)
      );
  end if;
  -- Plan Q4 = C (TG 23676): a self-declared result is visible ONLY to its owner. It is never public,
  -- so it never enters the catalog, the public ranking or another user's lists.
  if not exists (select 1 from pg_constraint where conname = 'evaluations_self_declared_private_check') then
    alter table public.evaluations add constraint evaluations_self_declared_private_check
      check (result_origin <> 'self_declared' or is_public = false);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- agents: connector 'local', declared provider and route
alter table public.agents drop constraint if exists agents_connector_check;
alter table public.agents add constraint agents_connector_check
  check (connector in ('endpoint', 'github', 'local'));

alter table public.agents add column if not exists provider_key text;
alter table public.agents add column if not exists route_key    text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agents_provider_key_check') then
    alter table public.agents add constraint agents_provider_key_check
      check (provider_key is null or provider_key ~ '^[a-z0-9][a-z0-9-]{0,31}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agents_route_key_check') then
    alter table public.agents add constraint agents_route_key_check
      check (route_key is null or route_key ~ '^[a-z0-9][a-z0-9-]{0,31}$');
  end if;
  -- A local agent has no repo: the GitHub fields stay empty.
  if not exists (select 1 from pg_constraint where conname = 'agents_local_fields_check') then
    alter table public.agents add constraint agents_local_fields_check
      check (connector <> 'local' or (gh_installation_id is null and repo_full_name is null));
  end if;
end $$;

comment on column public.agents.provider_key is
  'Declared lab: a key of packages/contracts/model-catalog/labs.json (the API checks the enum). Null = derived from the model id.';
comment on column public.agents.route_key is
  'Declared route: a key of packages/contracts/model-catalog/routes.json (the API checks the enum). Null = derived from the model id.';

-- ---------------------------------------------------------------------------------------------
-- task_versions: source 'local' (a private task folder on the owner's disk; digests only)
alter table public.task_versions add column if not exists contract_digest text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_versions_contract_digest_check') then
    alter table public.task_versions add constraint task_versions_contract_digest_check
      check (contract_digest is null or contract_digest ~ '^[0-9a-f]{64}$');
  end if;
end $$;

alter table public.task_versions drop constraint if exists task_versions_source_check;
alter table public.task_versions add constraint task_versions_source_check
  check (source in ('curated', 'github', 'local'));

alter table public.task_versions drop constraint if exists task_versions_source_fields_check;
alter table public.task_versions add constraint task_versions_source_fields_check check (
  (source = 'curated' and (not runnable or (pack_id is not null and pack_version is not null)))
  or (source = 'github' and gh_installation_id is not null and repo_full_name is not null
      and branch is not null and commit_sha is not null)
  -- local: the three digests, no repo, no pack, never runnable on the hosted worker.
  -- (`is not null` first: a regex match on NULL is NULL, and a NULL CHECK passes.)
  or (source = 'local' and contract_digest is not null
      and fixture_digest is not null and fixture_digest ~ '^[0-9a-f]{64}$'
      and hidden_digest is not null and hidden_digest ~ '^[0-9a-f]{64}$'
      and gh_installation_id is null and repo_full_name is null and commit_sha is null
      and pack_id is null and not runnable)
);

comment on column public.task_versions.contract_digest is
  'source = local: sha256 of the task.json of the owner''s folder (fixture_digest = environment, hidden_digest = hidden tests).';

-- ---------------------------------------------------------------------------------------------
-- user_models — custom models of one principal (the tenant). Never part of public.models.
create table if not exists public.user_models (
  owner_wallet   text not null,
  id             text not null
                 check (id ~ '^[a-z0-9][a-z0-9.-]{0,31}(/[a-z0-9][a-z0-9.-]{0,31})?/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  label          text not null
                 check (char_length(label) between 1 and 60 and label ~ '^[A-Za-z0-9 .,:;/()+_%$=&''#-]*$'),
  provider_key   text check (provider_key is null or provider_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  provider_label text check (provider_label is null
                             or (char_length(provider_label) between 1 and 40 and provider_label ~ '^[A-Za-z0-9 .,:;/()+_%$=&''#-]*$')),
  route_key      text not null check (route_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  created_at     timestamptz not null default now(),
  primary key (owner_wallet, id),
  -- A known lab (provider_key) or a custom provider name (provider_label), never both, never neither.
  constraint user_models_provider_check check ((provider_key is null) <> (provider_label is null))
);
comment on table public.user_models is
  'Custom models of one principal (plan ADR-4). Visible only to owner_wallet; never in GET /models or the public ranking. At most 50 per owner (apps/api).';

grant select, insert, update, delete on public.user_models to itera_api_service;
alter table public.user_models enable row level security;

-- ---------------------------------------------------------------------------------------------
-- cli_device_codes — device login of the local CLI (plan ADR-7)
create table if not exists public.cli_device_codes (
  device_code_sha256 text primary key check (device_code_sha256 ~ '^[0-9a-f]{64}$'),
  user_code          text not null unique check (user_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  principal          text,
  created_at         timestamptz not null default now(),
  approved_at        timestamptz,
  consumed_at        timestamptz,
  expires_at         timestamptz not null,
  -- Approval names the principal; consumption needs an approval.
  constraint cli_device_codes_approval_check check ((approved_at is null) = (principal is null)),
  constraint cli_device_codes_consumed_check check (consumed_at is null or approved_at is not null)
);
create index if not exists cli_device_codes_expires_idx on public.cli_device_codes (expires_at);

-- L5: the states of the device login (apps/api/src/cli-auth/). As ALTERs, so the file stays idempotent.
alter table public.cli_device_codes add column if not exists client_name text;
alter table public.cli_device_codes add column if not exists polled_at   timestamptz;
alter table public.cli_device_codes add column if not exists denied_at   timestamptz;
alter table public.cli_device_codes add column if not exists session_id  uuid;
alter table public.cli_device_codes add column if not exists revoked_at  timestamptz;
create unique index if not exists cli_device_codes_session_id_key on public.cli_device_codes (session_id);
create index if not exists cli_device_codes_principal_idx on public.cli_device_codes (principal) where principal is not null;

do $$
begin
  -- Short free text with no newline and no quote mark (the SAFE pattern of tma-local-result/1).
  if not exists (select 1 from pg_constraint where conname = 'cli_device_codes_client_name_check') then
    alter table public.cli_device_codes add constraint cli_device_codes_client_name_check
      check (client_name is null or (length(client_name) between 1 and 60 and client_name ~ '^[A-Za-z0-9 .,:;/()+_%$=&#-]+$'));
  end if;
  -- A code is approved or denied, never both.
  if not exists (select 1 from pg_constraint where conname = 'cli_device_codes_decision_check') then
    alter table public.cli_device_codes add constraint cli_device_codes_decision_check
      check (denied_at is null or approved_at is null);
  end if;
  -- The CLI session exists exactly when the code is consumed.
  if not exists (select 1 from pg_constraint where conname = 'cli_device_codes_session_check') then
    alter table public.cli_device_codes add constraint cli_device_codes_session_check
      check ((session_id is null) = (consumed_at is null));
  end if;
  -- Only an approved code can be revoked.
  if not exists (select 1 from pg_constraint where conname = 'cli_device_codes_revoked_check') then
    alter table public.cli_device_codes add constraint cli_device_codes_revoked_check
      check (revoked_at is null or approved_at is not null);
  end if;
end $$;
comment on table public.cli_device_codes is
  'Device login of the tma CLI (plan ADR-7). The device code is stored only as sha256; one use; expires_at = created_at + 600 s.';

grant select, insert, update, delete on public.cli_device_codes to itera_api_service;
alter table public.cli_device_codes enable row level security;

-- ---------------------------------------------------------------------------------------------
-- DATA: relabel the bench-import rows as self-declared (plan ADR-8). Deterministic and idempotent.
update public.runs
   set result_origin = 'self_declared'
 where provenance ->> 'source' = 'bench-import'
   and result_origin <> 'self_declared';

update public.evaluations
   set result_origin = 'self_declared', payment_kind = 'none', is_public = false
 where id in (select evaluation_id from public.runs
               where provenance ->> 'source' = 'bench-import' and evaluation_id is not null)
   and (result_origin <> 'self_declared' or payment_kind <> 'none' or is_public);

commit;
