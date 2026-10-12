-- 0000_baseline.sql — RECONSTRUCTED, NOT APPLIED. DOCUMENTATION ONLY.
--
-- This file records the schema that the hackathon Supabase project already holds (created by the
-- 2026-10-11 migration for the testmyagent.com pivot). Do NOT run it: every object below already
-- exists. It is the starting point that 0001+ migrations build on.
--
-- Source: a read-only introspection of the live `public` schema on 2026-10-12
-- (information_schema.columns, pg_constraint, pg_indexes, pg_policies), cross-checked against
-- apps/api/src/domain/repository.pg.ts. The original DDL file was not in this repository.
-- Live facts at that time: RLS enabled on every table; 2 anon SELECT policies; no functions;
-- no triggers.

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  name text not null,
  endpoint_url text not null,
  identity_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (vendor_id, name)
);
create index agents_vendor_id_idx on public.agents (vendor_id);

create table public.release_declarations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  release_ref text not null,
  declared_config_digest text,
  declared_at timestamptz not null default now(),
  unique (agent_id, release_ref)
);
create index release_declarations_agent_id_idx on public.release_declarations (agent_id);

create table public.task_packs (
  id text not null,
  version text not null,
  fixture_digest text,
  criteria_digest text,
  evaluator_ref text not null,
  created_at timestamptz not null default now(),
  primary key (id, version)
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  release_declaration_id uuid not null references public.release_declarations(id) on delete restrict,
  task_pack_id text not null,
  task_pack_version text not null,
  nonce text not null unique,
  budget jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    constraint runs_status_check check (status in ('pending', 'pass', 'fail', 'invalid', 'timeout', 'infra_error')),
  attempts integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  idempotency_key text,
  evidence_manifest jsonb,
  score_total integer,
  foreign key (task_pack_id, task_pack_version) references public.task_packs(id, version)
);
create unique index runs_idempotency_key_key on public.runs (idempotency_key) where idempotency_key is not null;
create index runs_nonce_idx on public.runs (nonce);
create index runs_release_declaration_id_idx on public.runs (release_declaration_id);

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  request_digest text,
  response_digest text,
  output_artifact_ref text,
  mode text not null default 'observed' check (mode in ('observed', 'vendor_declared')),
  occurred_at timestamptz not null default now(),
  output_artifact_content text
);
create index observations_run_id_idx on public.observations (run_id);

create table public.claim_manifests (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete restrict,
  task_ref text not null,
  release_ref text not null,
  criteria_results jsonb not null default '[]'::jsonb,
  limitations text,
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  canonical_digest_sha256 text,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
create index claim_manifests_run_id_idx on public.claim_manifests (run_id);

create table public.attestation_envelopes (
  id uuid primary key default gen_random_uuid(),
  claim_manifest_id uuid not null unique references public.claim_manifests(id) on delete restrict,
  network text not null default 'solana-devnet',
  attestation_address text,
  issuer_ref text,
  schema_ref text,
  manifest_digest text,
  status text not null default 'not_issued'
    check (status in ('not_issued', 'pending', 'confirmed', 'mismatch', 'expired', 'closed', 'unavailable')),
  issued_at timestamptz,
  updated_at timestamptz not null default now()
);
create index attestation_envelopes_claim_manifest_id_idx on public.attestation_envelopes (claim_manifest_id);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  claim_manifest_id uuid not null references public.claim_manifests(id) on delete cascade,
  recipient_org_ref text,
  next_action text,
  consent boolean not null default false,
  source text,
  created_at timestamptz not null default now()
);
create index reviews_claim_manifest_id_idx on public.reviews (claim_manifest_id);

create table public.evaluation_requests (
  id uuid primary key default gen_random_uuid(),
  requester_contact text not null,
  requester_role text,
  task_description text not null,
  status text not null default 'new' check (status in ('new', 'in_review', 'scheduled', 'declined')),
  created_at timestamptz not null default now()
);

-- Row level security: enabled on every table. The API connects as the database owner through
-- DATABASE_URL, so RLS does not filter it. Only two anon policies exist:
alter table public.vendors enable row level security;
alter table public.agents enable row level security;
alter table public.release_declarations enable row level security;
alter table public.task_packs enable row level security;
alter table public.runs enable row level security;
alter table public.observations enable row level security;
alter table public.claim_manifests enable row level security;
alter table public.attestation_envelopes enable row level security;
alter table public.reviews enable row level security;
alter table public.evaluation_requests enable row level security;

create policy "published claim manifests are publicly readable"
  on public.claim_manifests for select to anon
  using (visibility = 'public');

create policy "attestation envelopes of a published manifest are publicly read"
  on public.attestation_envelopes for select to anon
  using (exists (
    select 1 from public.claim_manifests cm
    where cm.id = attestation_envelopes.claim_manifest_id and cm.visibility = 'public'
  ));
