-- 0026_eval_routes.sql — one route table that holds the cited verdict (plan 20261112-tma-c8-routing-from-evals,
-- task T1; ADR-3, ADR-4, ADR-5; parent plan 20261112-tma-eval-studio-real-trace-evals ADR-20, ADR-24, ADR-25).
--
-- Adds:
--   eval_routes       one row per route decision: for one tenant and one use case (the L1 pair type/subtype), the
--                     route target (an env flag or a CLAUDE.md row), the new value and the old value of that target
--                     (the old value is the rollback, ADR-2), the agent that the route points to (by digest, parent
--                     ADR-25) and an optional fallback agent, and the CITED verdict that justifies the route: the
--                     picked rule (absolute | relative), the verdict, n, the evidence run ids, the compare profile
--                     digest and the policy version (ADR-3, ADR-5). The row moves through the states
--                     proposed -> approved -> live -> rolled_back | needs_check. A route row is history: the API role
--                     has no DELETE right on this table (an explicit REVOKE).
--
-- A use case with no live row uses today's value (the env flag or the CLAUDE.md row); no row is written for it.
--
-- ADR-5 (the gate in the schema): a row in approved, live, needs_check or rolled_back carries the full cited verdict,
-- n >= 5, at least one evidence run, an approver and an approval time, and a PASSING verdict under the picked rule
-- (absolute: same or close; relative: better or same). A not_yet or worse verdict can only stay proposed.
-- At most ONE live row per (tenant, use_case_key, route_target): a unique partial index.
--
-- Not here: no verdict table (C7-T6 closes as no_longer_needed, ADR-4): the verdict lives on the route row that
-- cites it. No trace text (parent ADR-1): every string column has a pattern and a length limit.
--
-- An actor key is a lower-case key (a slug or a principal id): ^[a-z0-9][a-z0-9_.:-]{0,63}$, the same as 0024. No
-- e-mail address and no display name.
--
-- Same posture as 0000-0024: RLS on, no policies, grants to itera_api_service (select, insert, update; NO delete).
-- No DB function, no trigger, no procedure: the logic stays in apps/api. No data change. One transaction.
-- Idempotent: a second apply changes 0 rows.
-- Production (mkfnbsnyvfkkfcjfpkxz): applied on merge by .github/workflows/db-apply.yml. The merge of this file is a
-- human merge (safe-admin-merge protected path db/migrations/**). Merge after 0025.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------------------------
-- eval_routes
create table if not exists public.eval_routes (
  id                              uuid primary key default gen_random_uuid(),
  tenant                          text not null check (tenant ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  -- The L1 pair type/subtype.
  use_case_key                    text not null
                                  check (use_case_key ~ '^[a-z0-9][a-z0-9_-]{0,31}/[a-z0-9][a-z0-9_-]{0,31}$'),
  route_target                    text not null
                                  check (route_target ~ '^env:[A-Z][A-Z0-9_]{1,63}$'
                                         or route_target ~ '^claude-md:[a-z0-9][a-z0-9_-]{0,63}$'),
  target_value                    text not null check (target_value ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  -- Null = the target had no earlier value.
  rollback_value                  text check (rollback_value is null or rollback_value ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  -- The agent of the route (field names of eval_variants, 0023).
  agent_sha256                    text not null check (agent_sha256 ~ '^[0-9a-f]{64}$'),
  harness                         text not null check (harness ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  harness_repo_sha                text check (harness_repo_sha is null or harness_repo_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  model_id                        text not null check (model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'),
  rules_sha256                    text check (rules_sha256 is null or rules_sha256 ~ '^[0-9a-f]{64}$'),
  skills_sha256                   text check (skills_sha256 is null or skills_sha256 ~ '^[0-9a-f]{64}$'),
  -- The fallback agent (optional).
  fallback_agent_sha256           text check (fallback_agent_sha256 is null or fallback_agent_sha256 ~ '^[0-9a-f]{64}$'),
  fallback_harness                text check (fallback_harness is null or fallback_harness ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  fallback_harness_repo_sha       text check (fallback_harness_repo_sha is null
                                              or fallback_harness_repo_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  fallback_model_id               text check (fallback_model_id is null
                                              or fallback_model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'),
  fallback_rules_sha256           text check (fallback_rules_sha256 is null or fallback_rules_sha256 ~ '^[0-9a-f]{64}$'),
  fallback_skills_sha256          text check (fallback_skills_sha256 is null or fallback_skills_sha256 ~ '^[0-9a-f]{64}$'),
  -- The cited verdict.
  picked_rule                     text check (picked_rule is null or picked_rule in ('absolute', 'relative')),
  verdict                         text,
  n                               integer check (n is null or n >= 0),
  evidence_run_ids                uuid[] not null default '{}',
  compare_profile_sha256          text check (compare_profile_sha256 is null or compare_profile_sha256 ~ '^[0-9a-f]{64}$'),
  policy_version                  text check (policy_version is null or policy_version ~ '^[a-z0-9][a-z0-9_.-]{0,31}$'),
  -- The life of the route.
  state                           text not null default 'proposed'
                                  check (state in ('proposed', 'approved', 'live', 'rolled_back', 'needs_check')),
  pr_url                          text check (pr_url is null
                                              or pr_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$'),
  rollback_pr_url                 text check (rollback_pr_url is null
                                              or rollback_pr_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$'),
  approved_by_actor               text check (approved_by_actor is null or approved_by_actor ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  created_at                      timestamptz not null default now(),
  approved_at                     timestamptz,
  live_at                         timestamptz,
  rolled_back_at                  timestamptz,
  updated_at                      timestamptz not null default now()
);

do $$
begin
  -- A fallback names both its agent and its model, or neither.
  if not exists (select 1 from pg_constraint where conname = 'eval_routes_fallback_pair_check') then
    alter table public.eval_routes add constraint eval_routes_fallback_pair_check
      check ((fallback_agent_sha256 is null) = (fallback_model_id is null));
  end if;
  -- The verdict set is tied to the picked rule; a rule without a verdict (or the reverse) is refused.
  -- Written so that it is never NULL (a NULL CHECK passes): both null, or both set and in the set of the rule.
  if not exists (select 1 from pg_constraint where conname = 'eval_routes_verdict_rule_check') then
    alter table public.eval_routes add constraint eval_routes_verdict_rule_check check (
      (picked_rule is null and verdict is null)
      or (picked_rule is not null and verdict is not null and (
            (picked_rule = 'absolute' and verdict in ('same', 'close', 'not_yet'))
            or (picked_rule = 'relative' and verdict in ('better', 'same', 'worse'))))
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_routes_evidence_max_check') then
    alter table public.eval_routes add constraint eval_routes_evidence_max_check
      check (cardinality(evidence_run_ids) <= 500);
  end if;
  -- ADR-5: past proposed, the row carries the full cited verdict, n >= 5, evidence, an approver, and a PASSING verdict.
  if not exists (select 1 from pg_constraint where conname = 'eval_routes_cited_verdict_check') then
    alter table public.eval_routes add constraint eval_routes_cited_verdict_check check (
      state = 'proposed' or (
        picked_rule is not null
        and verdict is not null
        and n is not null
        and n >= 5
        and compare_profile_sha256 is not null
        and policy_version is not null
        and approved_by_actor is not null
        and approved_at is not null
        and cardinality(evidence_run_ids) >= 1
        and ((picked_rule = 'absolute' and verdict in ('same', 'close'))
             or (picked_rule = 'relative' and verdict in ('better', 'same')))
      )
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_routes_live_check') then
    alter table public.eval_routes add constraint eval_routes_live_check
      check (state <> 'live' or (pr_url is not null and live_at is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_routes_rolled_back_check') then
    alter table public.eval_routes add constraint eval_routes_rolled_back_check
      check (state <> 'rolled_back' or (rollback_pr_url is not null and rolled_back_at is not null));
  end if;
end $$;

create index if not exists eval_routes_use_case_idx on public.eval_routes (tenant, use_case_key);
-- At most ONE live route per (tenant, use case, target).
create unique index if not exists eval_routes_one_live_idx
  on public.eval_routes (tenant, use_case_key, route_target) where state = 'live';

comment on table public.eval_routes is
  'One route decision per row (plan 20261112-tma-c8-routing-from-evals ADR-3, ADR-5): for a tenant and a use case, the target (env flag or CLAUDE.md row), its new and old value, the agent by digest (parent ADR-25), an optional fallback agent, and the cited verdict (rule, verdict, n, evidence runs, compare profile, policy version). Past proposed, a passing verdict with n >= 5 is required. A use case with no live row uses today''s value. History: the API role has no DELETE grant. No verdict table (ADR-4), no trace text.';
comment on column public.eval_routes.use_case_key is
  'The use case: the L1 pair type/subtype (for example fix/red-ci).';
comment on column public.eval_routes.route_target is
  'What the route sets: env:<FLAG> (an environment flag) or claude-md:<row> (a CLAUDE.md routing row).';
comment on column public.eval_routes.target_value is
  'The new value of the target when the route is live.';
comment on column public.eval_routes.rollback_value is
  'The value of the target before the route (ADR-2: the old value is the rollback). Null = the target had no earlier value.';
comment on column public.eval_routes.agent_sha256 is
  'sha256 of the canonical base agent version of the route (agentVersionSha256 in @itera/contracts; parent ADR-25).';
comment on column public.eval_routes.fallback_agent_sha256 is
  'The fallback agent (optional). fallback_agent_sha256 and fallback_model_id are both null or both set.';
comment on column public.eval_routes.picked_rule is
  'The rule of the cited verdict: absolute (verdict same | close | not_yet) or relative (better | same | worse).';
comment on column public.eval_routes.verdict is
  'The cited verdict. Past proposed it must pass: absolute same or close; relative better or same (ADR-5).';
comment on column public.eval_routes.n is
  'The number of compared cases behind the verdict. Past proposed, at least 5 (ADR-5).';
comment on column public.eval_routes.evidence_run_ids is
  'The ids of the runs that the verdict cites (at most 500). Past proposed, at least one.';
comment on column public.eval_routes.compare_profile_sha256 is
  'sha256 of the compare profile that produced the verdict.';
comment on column public.eval_routes.policy_version is
  'The version of the routing policy that picked the rule.';
comment on column public.eval_routes.state is
  'proposed | approved | live | rolled_back | needs_check. live needs pr_url and live_at; rolled_back needs rollback_pr_url and rolled_back_at.';
comment on column public.eval_routes.approved_by_actor is
  'The actor key of the approver (a slug or a principal id; never an e-mail address).';

grant select, insert, update on public.eval_routes to itera_api_service;
-- Supabase (and the hermetic stack) grant every new table to the API role by default privileges, so the
-- DELETE right is taken back explicitly: a route row is history.
revoke delete on public.eval_routes from itera_api_service;
alter table public.eval_routes enable row level security;

commit;
