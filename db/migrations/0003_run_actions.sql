-- 0003_run_actions.sql — agent tool calls of a sandboxed run + the run's encrypted BYOK model key (lane B, plan
-- 20261012-itera-agent-proof-route-change-fixes, shared contract "Schema").
--
-- NOT APPLIED automatically. Apply once, by hand, on the hackathon Supabase project, in one
-- transaction, AFTER 0001_runs_async.sql. Idempotent: safe to run twice.
--
-- One row per opencode `tool_use` event, in order (services/runner/src/trace.ts). The worker writes
-- the rows of a run in one transaction when the agent phase ends. No DB functions or triggers
-- (CLAUDE.md rule): ordering and limits live in the worker.

begin;

create table if not exists public.run_actions (
  id          bigserial primary key,
  run_id      uuid        not null references public.runs (id) on delete cascade,
  seq         int         not null check (seq >= 1),
  tool        text        not null,
  target      text,
  ok          boolean,
  occurred_at timestamptz not null default now(),
  unique (run_id, seq)
);

comment on table public.run_actions is
  'Tool calls of the agent in a sandboxed run. target = workspace-relative path, shell command or pattern, max 300 chars.';

-- BYOK (Tainan TG 20935: the user pays the model tokens of a run). The API stores the user's
-- OpenRouter key AES-256-GCM-encrypted (key from env ITERA_RUN_KEY_SECRET). The worker decrypts it
-- only to start the run's model gateway, and sets the column to NULL when the run ends.
alter table public.runs add column if not exists model_api_key_enc text;

-- Same model as 0000_baseline: RLS on, no policy. The API and the worker connect as the owner.
alter table public.run_actions enable row level security;

commit;
