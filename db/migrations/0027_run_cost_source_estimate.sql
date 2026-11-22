-- 0027_run_cost_source_estimate.sql — allow the cost source 'estimate' on a run (plan
-- 20261112-tma-c7-model-comparison-per-use-case, task C7-COST-LABEL; Tainan Q 4665c2f8 = A, 2026-11-22).
--
-- One stored run (3550f6ca, GLM-5.3) has measured tokens but no recorded cache split. The decision is to price it as
-- an ESTIMATE (an assumed cache split at the list price) and to keep the word "estimate" on that cost in every place
-- it shows. 0017 limits runs.model_cost_source to metered | derived | mixed | unpriced | none, so an estimate cannot
-- be stored with its own mark. This migration adds 'estimate' to that list. Nothing else changes: no new column, no
-- data change (the estimate is written by POST /eval-results/run-cost with the caller's session, not here), no grant.
--
-- 0017 created the check inline on the column, so Postgres named it runs_model_cost_source_check. The block below
-- drops every CHECK on public.runs whose definition reads model_cost_source (whatever its name), then adds the named
-- check again with the wider list. Every existing value stays valid, so the new check validates without a change.
--
-- Idempotent: safe to run twice. No DB functions, no triggers. Depends on 0017_run_provenance.sql.

begin;

set local lock_timeout = '5s';

do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.runs'::regclass
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%model_cost_source%'
  loop
    execute format('alter table public.runs drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.runs add constraint runs_model_cost_source_check
  check (model_cost_source is null or model_cost_source in ('metered', 'derived', 'mixed', 'unpriced', 'none', 'estimate'));

comment on column public.runs.model_cost_source is
  'How model_cost_usd was obtained: metered (provider USD), derived (tokens x price table), estimate (tokens x price table with an assumed cache split; shown as an estimate), unpriced, mixed, none.';

commit;
