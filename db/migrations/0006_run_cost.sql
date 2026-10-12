-- 0006_run_cost.sql — measured model cost of each run (lane G, plan 20261012-itera-agent-proof-route-change-fixes).
--
-- Tainan TG 20967 (plan 20261012-itera-testmyagent-ui-refactor, Q2 = B): ITERA pays the model
-- tokens, inside the US$0.10 run fee for now; later the price becomes dynamic per (task, model).
-- The runner's model gateway reads OpenRouter's `usage` of every model call (cost in USD, tokens)
-- and the worker writes the run's totals here when the run ends. GET /runs/:id shows
-- model_cost_usd, and GET /models/:id/estimate averages it per (task, model).
--
-- Also: runs.model_api_key_enc stays nullable — NULL now means "ITERA's platform key".
--
-- Applied by hand on the hackathon Supabase project, in one transaction. Idempotent. No DB function.

begin;

alter table public.runs add column if not exists model_cost_usd   numeric(12, 6);
alter table public.runs add column if not exists model_tokens_in  integer;
alter table public.runs add column if not exists model_tokens_out integer;

comment on column public.runs.model_cost_usd is
  'Model cost of the run in USD, as billed by OpenRouter (sum of usage.cost of every call through the run gateway). NULL = not measured.';
comment on column public.runs.model_tokens_in is 'Prompt tokens of all model calls of the run (OpenRouter usage.prompt_tokens).';
comment on column public.runs.model_tokens_out is 'Completion tokens of all model calls of the run (OpenRouter usage.completion_tokens).';

-- Supports GET /models/:id/estimate (average cost of finished runs per task).
create index if not exists runs_task_cost_idx
  on public.runs (task_pack_id, task_pack_version)
  where model_cost_usd is not null;

-- The API and the worker connect as itera_api_service. Column privileges follow the table grant;
-- repeated here so this file stands alone (same as 0003/0005).
grant select, insert, update, delete on public.runs to itera_api_service;

commit;
