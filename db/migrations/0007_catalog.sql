-- 0007_catalog.sql — task catalog, tags, models, profiles (U4, plan 20261012-itera-testmyagent-ui-refactor).
--
-- Gate answers (Tainan TG 2026-10-12):
--   Q4 = A — a user task comes from a GitHub repo through the same App, pinned to a commit
--            (branch + commit select). A task version records that pin.
--   Q5 = B — no copy of hidden tests: there is NO task_bundles table. The task is read through
--            the GitHub App at the pinned commit at run time; proofs pin the digests.
--   Q2 = B — ITERA pays the model tokens. "What the user can access" = models.enabled (allow-list).
--
-- Tables: profiles, tags, tasks, task_versions, task_tags, models, model_releases.
-- Seed: the nine public catalog tasks of the design (only the webhook-ledger one is runnable: its
-- version points at task_packs webhook-ledger/1), the 8 tool tags and 3 concept tags, and the 5
-- allow-listed models of apps/api/src/github/models.ts with one release each. The OpenRouter sync
-- (U21) fills prices, context length and releases later.
--
-- Same posture as 0000–0006: RLS on, no policies; the API connects as itera_api_service.
-- No DB functions, no triggers: catalog logic lives in apps/api. Idempotent (safe to re-run).

begin;

-- ---------------------------------------------------------------------------------------------
-- profiles — one row per wallet (the wallet address is the user id, SIWS).
create table if not exists public.profiles (
  wallet       text primary key,
  display_name text check (display_name is null or char_length(display_name) between 1 and 60),
  handle       text unique check (handle is null or handle ~ '^[a-z0-9][a-z0-9_-]{1,29}$'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- tags — two kinds: tools (Stripe API, Postgres, …) and concepts (Idempotency, …).
create table if not exists public.tags (
  id         text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,23}$'),
  name       text not null,
  kind       text not null check (kind in ('tool', 'concept')),
  sort       int not null default 0,
  created_by text,               -- wallet of the user that created the tag; null = curated
  created_at timestamptz not null default now()
);
create index if not exists tags_kind_sort_idx on public.tags (kind, sort);

-- ---------------------------------------------------------------------------------------------
-- tasks — one row per task (curated by ITERA, or authored by a user). Content lives in versions.
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  kind         text not null default 'itera' check (kind in ('itera', 'user')),
  owner_wallet text,
  name         text not null check (char_length(name) between 1 and 60),
  description  text not null check (char_length(description) <= 120),
  visibility   text not null default 'public' check (visibility in ('public', 'private')),
  status       text not null default 'ready' check (status in ('draft', 'validating', 'ready', 'invalid')),
  est_minutes  int check (est_minutes is null or est_minutes between 1 and 120),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- A user task always has an owner and is never public (public catalog tasks are curated).
  constraint tasks_user_owner_check check (kind <> 'user' or (owner_wallet is not null and visibility = 'private'))
);
create index if not exists tasks_owner_wallet_idx on public.tasks (owner_wallet) where owner_wallet is not null;

-- ---------------------------------------------------------------------------------------------
-- task_versions — an immutable version of a task. A new edit creates a new version.
--   source = 'curated' : an ITERA pack (pack_id / pack_version → task_packs, legacy bridge).
--   source = 'github'  : a repo read through the GitHub App, pinned to commit_sha (Gate Q4/Q5).
-- labels: free labels on the version, e.g. 'open-tests' / 'sealed-tests' (follow-up Q7, label only).
create table if not exists public.task_versions (
  id                 uuid primary key default gen_random_uuid(),
  task_id            uuid not null references public.tasks (id) on delete cascade,
  version            int not null check (version >= 1),
  source             text not null check (source in ('curated', 'github')),
  contract           jsonb not null default '{}'::jsonb,
  labels             text[] not null default '{}',
  -- curated
  pack_id            text,
  pack_version       text,
  -- github
  gh_installation_id bigint,
  repo_full_name     text,
  branch             text,
  commit_sha         text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'),
  repo_path          text not null default '.',
  -- digests pinned at validation / run time (no bytes stored: Gate Q5)
  fixture_digest     text,
  hidden_digest      text,
  solution_digest    text,
  hidden_tests_count int check (hidden_tests_count is null or hidden_tests_count >= 0),
  runnable           boolean not null default false,
  validation         jsonb,
  validated_at       timestamptz,
  created_by         text,
  created_at         timestamptz not null default now(),
  unique (task_id, version),
  constraint task_versions_source_fields_check check (
    (source = 'curated' and (not runnable or (pack_id is not null and pack_version is not null)))
    or (source = 'github' and gh_installation_id is not null and repo_full_name is not null
        and branch is not null and commit_sha is not null)
  )
);
create index if not exists task_versions_task_version_idx on public.task_versions (task_id, version desc);

-- ---------------------------------------------------------------------------------------------
create table if not exists public.task_tags (
  task_id uuid not null references public.tasks (id) on delete cascade,
  tag_id  text not null references public.tags (id) on delete cascade,
  primary key (task_id, tag_id)
);
create index if not exists task_tags_tag_idx on public.task_tags (tag_id);

-- ---------------------------------------------------------------------------------------------
-- models — OpenRouter models. enabled = ITERA's allow-list (ITERA pays the tokens, Gate Q2):
-- the sync job (U21) inserts new models with enabled = false and never flips enabled itself.
create table if not exists public.models (
  id                     text primary key,           -- OpenRouter id, e.g. anthropic/claude-haiku-4.5
  label                  text not null,
  provider               text not null,
  context_length         int,
  prompt_price_usd_m     numeric(14, 6),             -- USD per 1M prompt tokens
  completion_price_usd_m numeric(14, 6),             -- USD per 1M completion tokens
  supports_tools         boolean not null default true,
  enabled                boolean not null default false,
  sort                   int not null default 100,
  openrouter_created_at  timestamptz,
  synced_at              timestamptz,
  created_at             timestamptz not null default now()
);

-- model_releases — a dated/pinned release of a model (OpenRouter canonical_slug, or the id itself).
create table if not exists public.model_releases (
  id          text primary key,
  model_id    text not null references public.models (id) on delete cascade,
  released_at timestamptz,
  is_latest   boolean not null default false,
  synced_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists model_releases_model_idx on public.model_releases (model_id, released_at desc nulls last);
create unique index if not exists model_releases_one_latest_idx on public.model_releases (model_id) where is_latest;

-- ---------------------------------------------------------------------------------------------
-- Grants + RLS (RLS on, no policies; itera_api_service is BYPASSRLS).
grant select, insert, update, delete on public.profiles       to itera_api_service;
grant select, insert, update, delete on public.tags           to itera_api_service;
grant select, insert, update, delete on public.tasks          to itera_api_service;
grant select, insert, update, delete on public.task_versions  to itera_api_service;
grant select, insert, update, delete on public.task_tags      to itera_api_service;
grant select, insert, update, delete on public.models         to itera_api_service;
grant select, insert, update, delete on public.model_releases to itera_api_service;

alter table public.profiles       enable row level security;
alter table public.tags           enable row level security;
alter table public.tasks          enable row level security;
alter table public.task_versions  enable row level security;
alter table public.task_tags      enable row level security;
alter table public.models         enable row level security;
alter table public.model_releases enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Seed: tags (design brief 2.2, order kept).
insert into public.tags (id, name, kind, sort) values
  ('stripe-api',     'Stripe API',     'tool',    1),
  ('postgres',       'Postgres',       'tool',    2),
  ('prisma',         'Prisma',         'tool',    3),
  ('github-cli',     'GitHub CLI',     'tool',    4),
  ('github-actions', 'GitHub Actions', 'tool',    5),
  ('openpencil',     'OpenPencil',     'tool',    6),
  ('tailwind',       'Tailwind',       'tool',    7),
  ('vitest',         'Vitest',         'tool',    8),
  ('idempotency',    'Idempotency',    'concept', 1),
  ('concurrency',    'Concurrency',    'concept', 2),
  ('money-math',     'Money math',     'concept', 3)
on conflict (id) do update set name = excluded.name, kind = excluded.kind, sort = excluded.sort;

-- Seed: the nine public catalog tasks of the design. Slugs = the design ids (fixtures use them).
insert into public.tasks (slug, kind, name, description, visibility, status, est_minutes) values
  ('tsk_webhook_dup',  'itera', 'Duplicate settlement webhook',   'Second delivery must not double-credit the ledger.',        'public', 'ready', 6),
  ('tsk_refund_race',  'itera', 'Partial refund race condition',  'Concurrent refunds must never exceed the captured amount.', 'public', 'ready', 9),
  ('tsk_idem_keys',    'itera', 'Idempotency keys on retry',      'Client retries return the original response.',             'public', 'ready', 5),
  ('tsk_pg_index',     'itera', 'Missing index on hot query',     'Bring the p95 of the order lookup under budget.',           'public', 'ready', 3),
  ('tsk_gh_ci_fix',    'itera', 'Fix failing CI and open a PR',   'Diagnose the red build, push a fix, open the PR with gh.',  'public', 'ready', 7),
  ('tsk_gh_release',   'itera', 'Release notes from merged PRs',  'Draft notes from PRs merged since the last tag.',           'public', 'ready', 3),
  ('tsk_op_export',    'itera', 'Export frames to SVG',           'Batch-export named frames with stable IDs.',                'public', 'ready', 5),
  ('tsk_op_tokens',    'itera', 'Sync design tokens to code',     'Map OpenPencil styles to a Tailwind theme file.',           'public', 'ready', 5),
  ('tsk_flaky_state',  'itera', 'Flaky test with shared state',   'Fix the root cause, not the retry count.',                  'public', 'ready', 4)
on conflict (slug) do nothing;

-- Versions: v1 of each. Only tsk_webhook_dup is runnable (benchmarks/webhook-ledger, 5 hidden tests).
-- The other eight have no pack yet (pack_id null), carry the design's hidden-test counts and runnable = false ("Coming soon").
insert into public.task_versions (task_id, version, source, pack_id, pack_version, hidden_tests_count, runnable, contract, labels)
select t.id, 1, 'curated', v.pack_id, case when v.pack_id is null then null else '1' end, v.tests, v.runnable,
       jsonb_build_object('editable_paths', jsonb_build_array('src/**'), 'protected_paths', jsonb_build_array('tests/**', 'package.json')),
       '{sealed-tests}'::text[]
from (values
  ('tsk_webhook_dup', 'webhook-ledger',   5,  true),
  ('tsk_refund_race', null,      18, false),
  ('tsk_idem_keys',   null, 11, false),
  ('tsk_pg_index',    null,         8,  false),
  ('tsk_gh_ci_fix',   null,        12, false),
  ('tsk_gh_release',  null,       6,  false),
  ('tsk_op_export',   null,        10, false),
  ('tsk_op_tokens',   null,        9,  false),
  ('tsk_flaky_state', null,      9,  false)
) as v(slug, pack_id, tests, runnable)
join public.tasks t on t.slug = v.slug
on conflict (task_id, version) do nothing;

insert into public.task_tags (task_id, tag_id)
select t.id, v.tag_id
from (values
  ('tsk_webhook_dup', 'stripe-api'), ('tsk_webhook_dup', 'idempotency'),
  ('tsk_refund_race', 'stripe-api'), ('tsk_refund_race', 'concurrency'),
  ('tsk_idem_keys',   'stripe-api'), ('tsk_idem_keys',   'idempotency'),
  ('tsk_pg_index',    'postgres'),   ('tsk_pg_index',    'prisma'),
  ('tsk_gh_ci_fix',   'github-cli'), ('tsk_gh_ci_fix',   'github-actions'),
  ('tsk_gh_release',  'github-cli'),
  ('tsk_op_export',   'openpencil'),
  ('tsk_op_tokens',   'openpencil'), ('tsk_op_tokens',   'tailwind'),
  ('tsk_flaky_state', 'vitest'),     ('tsk_flaky_state', 'concurrency')
) as v(slug, tag_id)
join public.tasks t on t.slug = v.slug
on conflict do nothing;

-- Seed: the 5 allow-listed models (apps/api/src/github/models.ts), enabled, one release each.
insert into public.models (id, label, provider, enabled, sort) values
  ('anthropic/claude-haiku-4.5',    'Claude Haiku 4.5',    'Anthropic',   true, 1),
  ('anthropic/claude-sonnet-4.6',   'Claude Sonnet 4.6',   'Anthropic',   true, 2),
  ('qwen/qwen3-coder',              'Qwen3 Coder 480B',    'Qwen',        true, 3),
  ('moonshotai/kimi-k2.7-code',     'Kimi K2.7 Code',      'Moonshot AI', true, 4),
  ('deepseek/deepseek-v4.1-flash',  'DeepSeek V4.1 Flash', 'DeepSeek',    true, 5)
on conflict (id) do nothing;  -- never re-enable a model an admin disabled

insert into public.model_releases (id, model_id, is_latest)
select m.id, m.id, true
from public.models m
where m.id in ('anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.6', 'qwen/qwen3-coder',
               'moonshotai/kimi-k2.7-code', 'deepseek/deepseek-v4.1-flash')
  and not exists (select 1 from public.model_releases r where r.model_id = m.id)
on conflict (id) do nothing;

commit;
