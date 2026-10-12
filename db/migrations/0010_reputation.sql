-- 0010_reputation.sql — anti-collusion: sealed-test rule, self-evaluated label, task reputation and
-- run feedback (U27, plan 20261012-itera-testmyagent-ui-refactor; Q7 = B, Tainan TG 20979).
--
-- The rules live in apps/api/src/domain/reputation.ts (TypeScript). This file only adds columns and
-- one table. No DB functions, no triggers. Idempotent (safe to re-run). RLS on, no policies; the
-- API connects as itera_api_service (BYPASSRLS).
--
-- Depends on 0001 (runs), 0004 (proofs), 0007 (task_versions).

begin;

-- Sealed-test rule: a user task is ranked only when its source repo is private. The task-version
-- writer (U19) records the repo visibility it read through the GitHub App at the pinned commit.
-- null = unknown, which the API treats as unranked for a user task (fails closed).
alter table public.task_versions add column if not exists repo_private boolean;

-- Proofs carry the two wallets and the label, so a proof alone says whether it is self-evaluated.
--   task_author_wallet : tasks.owner_wallet (null for a curated ITERA task)
--   agent_owner_wallet : agents.owner_wallet
--   self_evaluated     : same wallet, or same GitHub installation account (task repo vs agent repo)
--   ranked             : the task passes the sealed-test rule (leaderboards skip ranked = false)
alter table public.proofs add column if not exists task_author_wallet text;
alter table public.proofs add column if not exists agent_owner_wallet text;
alter table public.proofs add column if not exists self_evaluated     boolean not null default false;
alter table public.proofs add column if not exists ranked             boolean not null default true;

-- One feedback answer per run, by the run owner: "did the result match reality?".
-- task_id = the catalog task uuid (text, like runs.task_id), resolved when the answer is stored.
create table if not exists public.run_feedback (
  run_id          uuid primary key references public.runs (id) on delete cascade,
  wallet          text not null,
  task_id         text,
  matched_reality boolean not null,
  note            text check (note is null or char_length(note) <= 500),
  created_at      timestamptz not null default now()
);
create index if not exists run_feedback_task_id_idx on public.run_feedback (task_id) where task_id is not null;

alter table public.run_feedback enable row level security;
grant select, insert, update, delete on public.run_feedback to itera_api_service;

commit;
