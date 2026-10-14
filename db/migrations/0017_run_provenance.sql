-- 0017_run_provenance.sql — result provenance of each run + benchmark campaigns with a cumulative stop
-- (K11, plan 20261012-testmyagent-dfl-benchmark-tasks; Tainan's research report: "record agent
-- commit, effective model, params, env version, CPU/mem, time limit per result").
--
-- The worker writes these columns in the same finish transaction as the score. Typed columns hold
-- what the campaign report filters and groups on; `provenance` holds the full record (params, image
-- digests, resources, limits) so a later field does not need a migration.
--
-- bench_campaigns: a benchmark campaign (K7) has a cumulative US$ cap. `services/runner/src/
-- bench-enqueue.ts` sums the metered OpenRouter cost of the campaign's runs before it queues a run,
-- and records the stop here when the cap is reached. opencode go runs spend subscription credit
-- and are reported apart (route), so they do not count against the OpenRouter cap.
--
-- Applied by hand on the TestMyAgent Supabase project, in one transaction. Idempotent. No DB function.

begin;

create table if not exists public.bench_campaigns (
  id           text primary key check (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  cap_usd      numeric(10, 4) not null check (cap_usd > 0),
  created_at   timestamptz not null default now(),
  stopped_at   timestamptz,
  stop_reason  text
);
comment on table public.bench_campaigns is
  'A benchmark campaign (K7). cap_usd = cumulative OpenRouter spend cap; stopped_at/stop_reason record the stop.';

alter table public.runs add column if not exists campaign_id        text references public.bench_campaigns(id);
alter table public.runs add column if not exists model_route        text check (model_route is null or model_route in ('openrouter', 'opencode-go'));
alter table public.runs add column if not exists model_requested    text;
alter table public.runs add column if not exists model_effective    text;
alter table public.runs add column if not exists model_provider     text;
alter table public.runs add column if not exists model_cost_source  text check (model_cost_source is null or model_cost_source in ('metered', 'derived', 'mixed', 'unpriced', 'none'));
alter table public.runs add column if not exists rate_limited       integer;
alter table public.runs add column if not exists wall_ms            integer;
alter table public.runs add column if not exists timeout_s          integer;
alter table public.runs add column if not exists provenance         jsonb;

comment on column public.runs.model_route is 'Upstream route of the run gateway: openrouter or opencode-go (K10).';
comment on column public.runs.model_requested is 'The agent model id the run was started with (agents.model at claim time).';
comment on column public.runs.model_effective is 'The model id the upstream ANSWERED with (most calls), not only the requested one.';
comment on column public.runs.model_provider is 'The provider that answered (OpenRouter `provider`, or the opencode go endpoint id), most calls.';
comment on column public.runs.model_cost_source is 'How model_cost_usd was obtained: metered (provider USD), derived (tokens x price table), unpriced, mixed, none.';
comment on column public.runs.rate_limited is 'Upstream 429 answers during the run (retried by the gateway). A 429 that survived the retries makes the run infra_error.';
comment on column public.runs.wall_ms is 'Measured agent wall time in ms (sandbox start to exit).';
comment on column public.runs.timeout_s is 'The task agent time limit (task.json agent.timeout_sec); the enforced cap is provenance.limits.wall_ms_cap.';
comment on column public.runs.provenance is 'Full result provenance: agent files digest, task version, model/provider/params, env versions (image digests, runner digest/commit, grader), resources, limits.';

create index if not exists runs_campaign_idx on public.runs (campaign_id) where campaign_id is not null;

grant select, insert, update, delete on public.runs to itera_api_service;
grant select, insert, update, delete on public.bench_campaigns to itera_api_service;
alter table public.bench_campaigns enable row level security;

commit;
