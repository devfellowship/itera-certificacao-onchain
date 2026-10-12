-- 0001_runs_async.sql — async runs owned by a wallet (lane A, plan
-- 20261012-itera-agent-proof-route-change-fixes, shared contract "Schema").
--
-- NOT APPLIED automatically. Apply once, by hand, on the hackathon Supabase project, in one
-- transaction. Idempotent: safe to run twice.
--
-- Effect on existing code: additive only. The legacy /evaluations routes do not read or write the
-- new columns, and every existing row keeps a status that the new check still allows.
--
-- Status lifecycle (new async path): queued -> running -> pass | fail | invalid | timeout | infra_error.
-- `pending` stays valid for the legacy /evaluations flow.
-- Phase (written by the worker): preparing | agent_running | grading | done.

begin;

alter table public.runs
  add column if not exists owner_wallet text,
  add column if not exists agent_version_id uuid,
  add column if not exists phase text,
  add column if not exists run_start_sig text,
  add column if not exists claimed_at timestamptz,
  add column if not exists worker_id text,
  add column if not exists error text;

alter table public.runs drop constraint if exists runs_status_check;
alter table public.runs add constraint runs_status_check
  check (status in ('pending', 'queued', 'running', 'pass', 'fail', 'invalid', 'timeout', 'infra_error'));

alter table public.runs drop constraint if exists runs_phase_check;
alter table public.runs add constraint runs_phase_check
  check (phase is null or phase in ('preparing', 'agent_running', 'grading', 'done'));

-- Worker claim: `... where status = 'queued' order by started_at for update skip locked limit 1`.
create index if not exists runs_queued_started_at_idx on public.runs (started_at) where status = 'queued';
-- Owner list (GET /runs?mine=1) and the per-wallet daily limit (5 runs / 24h).
create index if not exists runs_owner_wallet_started_at_idx on public.runs (owner_wallet, started_at desc)
  where owner_wallet is not null;

-- agent_version_id references public.agent_versions(id) (lane C, 0002). The foreign key is added
-- in 0002 or later, after that table exists, so 0001 can be applied first.

commit;
