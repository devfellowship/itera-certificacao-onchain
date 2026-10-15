-- 0020_runner_heartbeats.sql — runner liveness for GET /health (T12, plan
-- 20261015-testmyagent-web2-client).
--
-- Adds:
--   runner_heartbeats   one row per runner worker. The worker upserts its row every 30 s
--                       (services/runner/src/heartbeat.ts). The API reads max(seen_at) in GET /health
--                       as `runnerSeenAt`. With TMA_HEALTH_REQUIRE_RUNNER=true a value older than
--                       5 minutes makes /health answer 503.
--
-- Same posture as 0000–0019: RLS on, no policies, grants to itera_api_service (the role the API and
-- the runner both connect as). No DB functions, no triggers. Idempotent.

begin;

create table if not exists public.runner_heartbeats (
  runner_id    text primary key,
  seen_at      timestamptz not null,
  version      text,
  concurrency  int
);

grant select, insert, update, delete on public.runner_heartbeats to itera_api_service;
alter table public.runner_heartbeats enable row level security;

commit;
