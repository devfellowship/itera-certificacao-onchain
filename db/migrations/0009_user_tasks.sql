-- 0009_user_tasks.sql — My tasks: user-authored tasks read through the GitHub App (U19, plan
-- 20261012-itera-testmyagent-ui-refactor).
--
-- Gate answers (Tainan TG 2026-10-12):
--   Q4 = A — the source of a user task is a GitHub repo through the same App, pinned to branch + commit.
--   Q5 = B — NO copy: the API and the runner read the task folder at the pinned commit through the App
--            on every validation and every run. No bytes are stored; only digests are pinned.
--   Q7     — a ranked task needs a PRIVATE repo. A task in a public repo runs, but its tests are open
--            ("open-tests") and its runs are unranked. task_versions.repo_private records it.
--
-- Adds:
--   tasks.deleted_at               soft delete (DELETE /tasks/:id)
--   task_versions.repo_private     visibility of the repo at version time (GitHub API repo.private)
--   task_validations               one row per validation request: the queue the runner claims
--                                  (FOR UPDATE SKIP LOCKED), and the gate result it writes back.
--
-- A user task version that passes the gate gets a task_packs row `user-<task_version_id>` / `1`
-- (written by the runner, in the same transaction as the result), so the evaluation flow and the
-- runs table (task_pack_id is NOT NULL with a foreign key) work unchanged. The runner recognises the
-- `user-` prefix and reads the task folder from GitHub at the pinned commit.
--
-- Same posture as 0000–0008: RLS on, no policies, grants to itera_api_service. No DB functions, no
-- triggers. Idempotent.

begin;

alter table public.tasks add column if not exists deleted_at timestamptz;

alter table public.task_versions add column if not exists repo_private boolean;

create table if not exists public.task_validations (
  id               uuid primary key default gen_random_uuid(),
  task_id          uuid not null references public.tasks (id) on delete cascade,
  task_version_id  uuid not null references public.task_versions (id) on delete cascade,
  requested_by     text not null,
  status           text not null default 'queued'
                   check (status in ('queued', 'running', 'ready', 'invalid', 'error')),
  repeats          int not null default 3 check (repeats between 1 and 5),
  result           jsonb,
  error            text,
  worker_id        text,
  created_at       timestamptz not null default now(),
  claimed_at       timestamptz,
  completed_at     timestamptz
);
create index if not exists task_validations_queue_idx on public.task_validations (created_at) where status = 'queued';
create index if not exists task_validations_version_idx on public.task_validations (task_version_id, created_at desc);
-- At most one open validation per version.
create unique index if not exists task_validations_one_open_idx on public.task_validations (task_version_id)
  where status in ('queued', 'running');

grant select, insert, update, delete on public.task_validations to itera_api_service;
alter table public.task_validations enable row level security;

-- The runner registers a validated user version as a task pack (see header) with
-- `insert ... on conflict do nothing`: itera_api_service already holds SELECT and INSERT on
-- task_packs (verified 2026-10-12 with has_table_privilege), so no grant is needed here.

commit;
