-- 0008_evaluations_payments.sql — evaluations (one agent × N tasks × one payment) and the SOL fee
-- (U6, plan 20261012-itera-testmyagent-ui-refactor, ADR-1 and ADR-2).
--
-- Idempotent: safe to run twice. No DB functions, no triggers: the roll-up, the price quote and
-- the payment check live in apps/api (src/http/evaluations-v2-router.ts). Every new table: RLS on,
-- no policies, grants to itera_api_service (BYPASSRLS) in this file.
--
-- Task references: 0007_catalog (U4: tasks, task_versions) may land after this file. So
-- runs.task_id / runs.task_version_id and the evaluation task list are TEXT references (a task
-- uuid as text, or a task-pack id on the legacy bridge). The foreign keys arrive in a later
-- migration, with `alter column ... type uuid using ...::uuid`, once every row holds a uuid.
--
-- Depends on 0001 (runs.owner_wallet), 0002 (agents.owner_wallet, agent_versions), 0004 (proofs).

begin;

-- One row per quote. The quote becomes a payment when a transfer with its reference confirms.
create table if not exists public.payments (
  id                uuid primary key default gen_random_uuid(),
  evaluation_id     uuid,
  payer_wallet      text not null,
  agent_id          uuid not null,
  task_ids          jsonb not null,
  task_count        int not null check (task_count > 0),
  price_usd_per_run numeric(10,4) not null,
  amount_usd        numeric(10,4) not null,
  amount_lamports   bigint not null check (amount_lamports > 0),
  sol_usd_rate      numeric(14,6) not null,
  price_source      text not null check (price_source in ('pyth', 'coingecko', 'fixed')),
  treasury          text not null,
  quote_expires_at  timestamptz not null,
  reference_pubkey  text not null unique,
  tx_sig            text unique,
  status            text not null default 'pending' check (status in ('pending', 'confirmed', 'failed', 'refunded')),
  confirmed_at      timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists payments_payer_wallet_idx on public.payments (payer_wallet, created_at desc);

create table if not exists public.evaluations (
  id                uuid primary key default gen_random_uuid(),
  slug              text unique,
  short_id          text unique,
  owner_wallet      text not null,
  agent_id          uuid not null references public.agents (id) on delete restrict,
  agent_version_id  uuid not null references public.agent_versions (id) on delete restrict,
  model_id          text not null,
  model_release     text,
  -- [{taskId, taskVersionId, packId, packVersion, slug, name}] in seq order (seq = index + 1).
  tasks             jsonb not null default '[]'::jsonb,
  status            text not null default 'pending'
                    check (status in ('pending', 'in_progress', 'review', 'issuing', 'issued', 'cancelled', 'failed')),
  task_count        int not null check (task_count > 0),
  price_usd_per_run numeric(10,4) not null,
  fee_usd           numeric(10,4) not null,
  fee_lamports      bigint not null,
  sol_usd_rate      numeric(14,6) not null,
  price_source      text not null,
  payment_id        uuid unique references public.payments (id) on delete restrict,
  score             numeric(5,1),
  pass_count        int not null default 0,
  fail_count        int not null default 0,
  invalid_count     int not null default 0,
  tests_passed      int not null default 0,
  tests_total       int not null default 0,
  contracts_sha256  text,
  manifest_sha256   text unique,
  is_public         boolean not null default false,
  -- Optional BYOK (Gate Q2 = B: ITERA pays the tokens; the API keeps BYOK as an option). Wiped
  -- with the last run.
  model_api_key_enc text,
  -- Gate Q1 = A: one free retry of an infra_error run per evaluation.
  free_retries_used int not null default 0,
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  issued_at         timestamptz,
  cancelled_at      timestamptz
);
create index if not exists evaluations_owner_wallet_idx on public.evaluations (owner_wallet, created_at desc);
create index if not exists evaluations_agent_id_idx on public.evaluations (agent_id, created_at desc);
-- The evaluation-issuer job scans the open evaluations only.
create index if not exists evaluations_open_idx on public.evaluations (created_at)
  where status in ('pending', 'in_progress', 'issuing');

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_evaluation_id_fkey') then
    alter table public.payments add constraint payments_evaluation_id_fkey
      foreign key (evaluation_id) references public.evaluations (id) on delete set null;
  end if;
end $$;

-- Runs of an evaluation. The worker is unchanged: it still claims `queued` runs.
alter table public.runs add column if not exists evaluation_id   uuid;
alter table public.runs add column if not exists task_id         text;
alter table public.runs add column if not exists task_version_id text;
alter table public.runs add column if not exists seq             int;
-- A free retry (Gate Q1) points at the run it replaces.
alter table public.runs add column if not exists retry_of_run_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'runs_evaluation_id_fkey') then
    alter table public.runs add constraint runs_evaluation_id_fkey
      foreign key (evaluation_id) references public.evaluations (id) on delete restrict;
  end if;
end $$;
create unique index if not exists runs_evaluation_seq_key on public.runs (evaluation_id, seq)
  where evaluation_id is not null and seq is not null;
create index if not exists runs_evaluation_id_idx on public.runs (evaluation_id) where evaluation_id is not null;

-- Agents: the fields of screens 01, 02 and 08.
alter table public.agents add column if not exists slug          text;
alter table public.agents add column if not exists description   text;
alter table public.agents add column if not exists visibility    text not null default 'listed';
alter table public.agents add column if not exists status        text not null default 'draft';
alter table public.agents add column if not exists branch        text;
alter table public.agents add column if not exists pinned_commit text;
alter table public.agents add column if not exists model_release text;
alter table public.agents add column if not exists listed_at     timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agents_slug_key') then
    alter table public.agents add constraint agents_slug_key unique (slug);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agents_description_len_check') then
    alter table public.agents add constraint agents_description_len_check
      check (description is null or char_length(description) <= 90);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agents_visibility_check') then
    alter table public.agents add constraint agents_visibility_check check (visibility in ('private', 'listed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agents_status_check') then
    alter table public.agents add constraint agents_status_check check (status in ('draft', 'active'));
  end if;
end $$;

-- Proofs: the evaluation a run proof belongs to.
alter table public.proofs add column if not exists evaluation_id uuid;
create index if not exists proofs_evaluation_id_idx on public.proofs (evaluation_id) where evaluation_id is not null;

alter table public.payments enable row level security;
alter table public.evaluations enable row level security;

grant select, insert, update, delete on public.payments to itera_api_service;
grant select, insert, update, delete on public.evaluations to itera_api_service;

commit;
