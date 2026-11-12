-- 0023_eval_results.sql — test cases, agent variants, grader versions and grader results, and the structural
-- trajectory columns (plan 20261112-tma-c4-result-store-trajectory-upload, tasks T2 and T8; ADR-1, ADR-2, ADR-4,
-- ADR-5; parent plan 20261112-tma-eval-studio-real-trace-evals ADR-2, ADR-10, ADR-11, ADR-16, ADR-18, ADR-19,
-- ADR-25, ADR-26). The upload contracts that feed these tables: packages/contracts/schemas/local-result-v2.schema.json
-- (tma-local-result/2) and trajectory.schema.json (tma-trajectory/1), tasks T1 and T8.
--
-- The model (parent ADR-26): a TEST CASE (the problem) and an AGENT VARIANT (what is tested) are two independent
-- objects. A run crosses one case and one variant, N:N: the same variant runs on many cases, a case runs many
-- variants.
--
-- Adds:
--   eval_variants     one agent variant: a BASE agent version (harness, harness version, harness repo commit,
--                     model, rules digest, skills digest, configured MCP manifest digest, configured tools digest)
--                     plus ONE diff (variant_sha256, change_kind). agent_sha256 = the digest of the base agent
--                     version (agentVersionSha256 in @itera/contracts). Unique per (tenant, owner_wallet,
--                     agent_sha256, variant_sha256). No case: a variant is not bound to a problem.
--   eval_cases        one test case (a tma-case/1 manifest): its key and digests only. Unique per
--                     (tenant, owner_wallet, case_key, manifest_sha256): a changed manifest is a new case.
--                     origin_pin_sha256 = provenance of the origin trace (tma-pin/1), never an agent binding.
--                     baseline_variant_id = THE baseline of the case (one column, so one baseline per case).
--   grader_versions   the grader registry: id@semver + the code digest (parent ADR-10). A judge also
--                     records its model, rubric and params digests and its calibration (tpr, tnr).
--   grader_results    one row per (run, grader version) grading. A re-grade ADDS a row: the API role
--                     has no UPDATE right on this table (an explicit REVOKE).
--   runs.case_id, runs.variant_id, runs.prediction_sha256, runs.infra_ok
--                     nullable; existing rows stay untouched (v1 uploads and hosted runs keep null). The pair
--                     (case_id, variant_id) is the crossing; prediction_sha256 is the prediction of that variant
--                     against the case baseline.
--   run_actions       the tma-trajectory/1 columns, nullable (plan ADR-2: no new trajectory table).
--                     An uploaded step writes target = target_redacted (at most 120 characters).
--
-- Tenancy (plan ADR-4, parent ADR-11): every new table has `tenant` (a text key; the fleet is
-- 'devfellowship'). A composite foreign key keeps a case's baseline variant in the tenant of the case and a
-- grader result in the tenant of its grader version, with no trigger. The API writes the case and the variant
-- of a run from the same tenant.
--
-- Not here (plan ADR-5): no verdict table and no route table (C7 and C8 own them).
--
-- Same posture as 0000–0022: RLS on, no policies, grants to itera_api_service (the role the API and the
-- runner both connect as). No DB functions, no triggers: the logic stays in apps/api. No text from a
-- trace: every string column has a pattern and a length limit. No data change.
-- Idempotent: safe to run twice (a second apply changes 0 rows).
-- Edited in place by T8 (2026-11-12) before any persistent apply: the first shape (merged in #195) bound a
-- variant to a case. It was applied only to CI throwaway databases. The guard below refuses to run on a
-- database that holds that first shape, so this file never silently skips its tables there: such a database
-- needs a new migration (0024) instead.
-- Production (mkfnbsnyvfkkfcjfpkxz): NOT applied on merge. Task T7 applies it by hand, in one transaction,
-- after a rolled-back rehearsal and only after Tainan's OK (plan ADR-6, Q-C4-1).

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Guard: the first 0023 shape (eval_variants.case_id) must not be present.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'eval_variants' and column_name = 'case_id') then
    raise exception 'eval_variants.case_id exists: this database has the first 0023 shape (variant bound to a case). Write migration 0024 to move it; do not re-run 0023.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- eval_variants (the agent variant; independent of any case)
create table if not exists public.eval_variants (
  id                   uuid primary key default gen_random_uuid(),
  tenant               text not null check (tenant ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  owner_wallet         text not null check (char_length(owner_wallet) between 1 and 128),
  -- The base agent version (field names of tma-pin/1).
  agent_sha256         text not null check (agent_sha256 ~ '^[0-9a-f]{64}$'),
  harness              text not null check (harness ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  harness_version      text check (harness_version is null or harness_version ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$'),
  harness_repo_sha     text check (harness_repo_sha is null or harness_repo_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  model_id             text not null
                       check (model_id ~ '^[a-z0-9][a-z0-9.-]{0,31}(/[a-z0-9][a-z0-9.-]{0,31})?/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  rules_sha256         text check (rules_sha256 is null or rules_sha256 ~ '^[0-9a-f]{64}$'),
  skills_sha256        text check (skills_sha256 is null or skills_sha256 ~ '^[0-9a-f]{64}$'),
  mcp_manifest_sha256  text check (mcp_manifest_sha256 is null or mcp_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  tools_sha256         text check (tools_sha256 is null or tools_sha256 ~ '^[0-9a-f]{64}$'),
  -- The ONE diff on the base agent.
  variant_sha256       text not null check (variant_sha256 ~ '^[0-9a-f]{64}$'),
  label                text not null
                       check (char_length(label) between 1 and 60 and label ~ '^[A-Za-z0-9 .,:;/()+_%$=&''#-]*$'),
  change_kind          text not null check (change_kind in
                         ('prompt', 'rules', 'skill', 'retrieval', 'memory', 'model', 'tools', 'mcp', 'permissions',
                          'orchestration', 'limits', 'harness', 'none')),
  created_at           timestamptz not null default now(),
  -- change_kind none is the base agent unchanged: its diff digest is the sha256 of the empty string.
  constraint eval_variants_none_diff_check check (
    change_kind <> 'none' or variant_sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ),
  constraint eval_variants_key unique (tenant, owner_wallet, agent_sha256, variant_sha256),
  -- The target of the composite foreign key of eval_cases.baseline_variant_id (the baseline is in the case's tenant).
  constraint eval_variants_id_tenant_key unique (id, tenant)
);
create index if not exists eval_variants_owner_idx on public.eval_variants (tenant, owner_wallet, created_at desc);

comment on table public.eval_variants is
  'One agent variant (parent plan ADR-26): a base agent version (harness, harness_repo_sha, model, rules, skills, configured MCP manifest and tools, by digest) plus ONE diff (variant_sha256, change_kind). Independent of any case: runs (case_id, variant_id) cross the two, N:N.';
comment on column public.eval_variants.agent_sha256 is
  'sha256 of the canonical base agent version (agentVersionSha256 in @itera/contracts). A route points to an agent (parent ADR-25).';
comment on column public.eval_variants.mcp_manifest_sha256 is
  'The MCP servers and tools that the agent has CONFIGURED. The environment servers of a case (seeded test state) are part of the case manifest, not this.';
comment on column public.eval_variants.tools_sha256 is
  'The configured built-in tools, permissions and scopes of the agent.';

grant select, insert, update, delete on public.eval_variants to itera_api_service;
alter table public.eval_variants enable row level security;

-- ---------------------------------------------------------------------------------------------
-- eval_cases (the test case: the problem)
create table if not exists public.eval_cases (
  id                   uuid primary key default gen_random_uuid(),
  tenant               text not null check (tenant ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  owner_wallet         text not null check (char_length(owner_wallet) between 1 and 128),
  case_key             text not null check (case_key ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  manifest_sha256      text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  origin_pin_sha256    text check (origin_pin_sha256 is null or origin_pin_sha256 ~ '^[0-9a-f]{64}$'),
  mode                 text not null check (mode in ('replay', 'trace_review')),
  use_case_key         text not null check (use_case_key ~ '^[a-z0-9][a-z0-9-]{0,30}(/[a-z0-9][a-z0-9-]{0,30})?$'),
  task_id              uuid references public.tasks (id) on delete set null,
  task_version_id      uuid references public.task_versions (id) on delete set null,
  baseline_variant_id  uuid,
  created_at           timestamptz not null default now(),
  -- A replay case has an origin pin (the tma-local-result/2 validator rule).
  constraint eval_cases_replay_pin_check check (mode <> 'replay' or origin_pin_sha256 is not null),
  constraint eval_cases_key unique (tenant, owner_wallet, case_key, manifest_sha256),
  -- MATCH SIMPLE: checked only when baseline_variant_id is set. The baseline variant is in the case's tenant.
  constraint eval_cases_baseline_variant_fkey foreign key (baseline_variant_id, tenant)
    references public.eval_variants (id, tenant) on delete restrict
);
create index if not exists eval_cases_owner_idx on public.eval_cases (tenant, owner_wallet, created_at desc);

comment on table public.eval_cases is
  'One test case (tma-case/1 manifest; parent plan ADR-26): the problem, fixed. manifest_sha256 covers the input, the environment (with the ENVIRONMENT tools), the expected output and the graders. Key and digests only, no trace text (plan 20261112-tma-c4-result-store-trajectory-upload ADR-3). It binds no agent, model or configured tool. tenant = the result plane tenant; the fleet is devfellowship (ADR-4).';
comment on column public.eval_cases.origin_pin_sha256 is
  'Provenance only: sha256 of the tma-pin/1 record of the origin trace. It is never a binding of the case to an agent (parent ADR-26).';
comment on column public.eval_cases.baseline_variant_id is
  'The baseline agent variant of the case: one per case (parent ADR-19, plan Q-T4 = A). The first baseline wins; the API answers 409 baseline_exists for another one.';
comment on column public.eval_cases.use_case_key is
  'The use case (an L2 cluster key, for example fix/red-ci). Parent plan ADR-18.';

grant select, insert, update, delete on public.eval_cases to itera_api_service;
alter table public.eval_cases enable row level security;

-- ---------------------------------------------------------------------------------------------
-- grader_versions
create table if not exists public.grader_versions (
  id                 uuid primary key default gen_random_uuid(),
  tenant             text not null check (tenant ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  grader_id          text not null check (grader_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  semver             text not null check (semver ~ '^\d{1,4}\.\d{1,4}\.\d{1,4}$'),
  kind               text not null check (kind in ('code', 'judge', 'human')),
  code_sha256        text not null check (code_sha256 ~ '^[0-9a-f]{64}$'),
  -- Judge fields (nullable; a code or human grader leaves them null).
  judge_model_id     text check (judge_model_id is null
                                 or judge_model_id ~ '^[a-z0-9][a-z0-9.-]{0,31}(/[a-z0-9][a-z0-9.-]{0,31})?/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  rubric_sha256      text check (rubric_sha256 is null or rubric_sha256 ~ '^[0-9a-f]{64}$'),
  params_sha256      text check (params_sha256 is null or params_sha256 ~ '^[0-9a-f]{64}$'),
  tpr                numeric(5,4) check (tpr is null or tpr between 0 and 1),
  tnr                numeric(5,4) check (tnr is null or tnr between 0 and 1),
  test_split_sha256  text check (test_split_sha256 is null or test_split_sha256 ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz not null default now(),
  constraint grader_versions_judge_fields_check check (
    kind = 'judge'
    or (judge_model_id is null and rubric_sha256 is null and params_sha256 is null
        and tpr is null and tnr is null and test_split_sha256 is null)
  ),
  constraint grader_versions_key unique (tenant, grader_id, semver, code_sha256),
  -- The target of the composite foreign key of grader_results.
  constraint grader_versions_id_tenant_key unique (id, tenant)
);

comment on table public.grader_versions is
  'Grader registry: id@semver plus the code digest (parent plan ADR-10). A judge also records its model, rubric and params digests and its calibration (tpr, tnr on the test split).';

grant select, insert, update, delete on public.grader_versions to itera_api_service;
alter table public.grader_versions enable row level security;

-- ---------------------------------------------------------------------------------------------
-- grader_results (append-only for the API role: a re-grade adds a row, never an update)
create table if not exists public.grader_results (
  id                 uuid primary key default gen_random_uuid(),
  tenant             text not null,
  run_id             uuid not null references public.runs (id) on delete cascade,
  grader_version_id  uuid not null,
  pass               boolean not null,
  score              numeric(7,4) check (score is null or score between 0 and 100),
  weight             numeric(7,4) not null check (weight between 0 and 100),
  hard_gate          boolean not null,
  decisive           boolean not null,
  infra_ok           boolean,
  graded_at          timestamptz not null default now(),
  constraint grader_results_grader_version_fkey foreign key (grader_version_id, tenant)
    references public.grader_versions (id, tenant) on delete restrict
);
create index if not exists grader_results_run_idx on public.grader_results (run_id, graded_at);
create index if not exists grader_results_grader_version_idx on public.grader_results (grader_version_id);

comment on table public.grader_results is
  'One grading of one run by one grader version. A re-grade adds a row (the API role has no UPDATE grant). weight = the weight that the case declares for this grader.';

grant select, insert, delete on public.grader_results to itera_api_service;
-- Supabase (and the hermetic stack) grant every new table to the API role by default privileges, so the
-- UPDATE right is taken back explicitly.
revoke update on public.grader_results from itera_api_service;
alter table public.grader_results enable row level security;

-- ---------------------------------------------------------------------------------------------
-- runs: the crossing of a case and a variant, the prediction, infra_ok (nullable; old rows untouched)
alter table public.runs add column if not exists case_id           uuid;
alter table public.runs add column if not exists variant_id        uuid;
alter table public.runs add column if not exists prediction_sha256 text;
alter table public.runs add column if not exists infra_ok          boolean;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'runs_case_id_fkey') then
    alter table public.runs add constraint runs_case_id_fkey
      foreign key (case_id) references public.eval_cases (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'runs_variant_id_fkey') then
    alter table public.runs add constraint runs_variant_id_fkey
      foreign key (variant_id) references public.eval_variants (id) on delete restrict;
  end if;
  -- A v2 run has both keys; a v1 or hosted run has neither, and no prediction.
  if not exists (select 1 from pg_constraint where conname = 'runs_case_variant_pair_check') then
    alter table public.runs add constraint runs_case_variant_pair_check
      check ((case_id is null) = (variant_id is null) and (case_id is not null or prediction_sha256 is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'runs_prediction_sha256_check') then
    alter table public.runs add constraint runs_prediction_sha256_check
      check (prediction_sha256 is null or prediction_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

create index if not exists runs_case_id_idx    on public.runs (case_id, variant_id) where case_id is not null;
create index if not exists runs_variant_id_idx on public.runs (variant_id)          where variant_id is not null;

comment on column public.runs.case_id is
  'The test case of a tma-local-result/2 run (null for v1 uploads and hosted runs). With variant_id: the crossing.';
comment on column public.runs.variant_id is
  'The agent variant of a tma-local-result/2 run. Independent of case_id: (case_id, variant_id) is the N:N crossing.';
comment on column public.runs.prediction_sha256 is
  'sha256 of the written prediction of this variant against the case baseline (null for the baseline and for v1 and hosted runs).';
comment on column public.runs.infra_ok is
  'false = the run failed for an infrastructure reason, not for the agent. Null = not reported.';

-- ---------------------------------------------------------------------------------------------
-- run_actions: the tma-trajectory/1 step columns (nullable; plan ADR-2)
alter table public.run_actions add column if not exists parent_seq    int;
alter table public.run_actions add column if not exists turn          int;
alter table public.run_actions add column if not exists tool_family   text;
alter table public.run_actions add column if not exists status        text;
alter table public.run_actions add column if not exists error_class   text;
alter table public.run_actions add column if not exists duration_ms   int;
alter table public.run_actions add column if not exists tokens_in     bigint;
alter table public.run_actions add column if not exists tokens_out    bigint;
alter table public.run_actions add column if not exists target_kind   text;
alter table public.run_actions add column if not exists args_sha256   text;
alter table public.run_actions add column if not exists result_sha256 text;
alter table public.run_actions add column if not exists retry_of      int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'run_actions_trajectory_check') then
    alter table public.run_actions add constraint run_actions_trajectory_check check (
      (parent_seq is null or (parent_seq >= 1 and parent_seq < seq))
      and (retry_of is null or (retry_of >= 1 and retry_of < seq))
      and (turn is null or turn between 0 and 100000)
      and (tool_family is null or tool_family in
           ('builtin', 'shell', 'git', 'gh', 'ssh', 'web', 'skill-bash', 'mcp', 'agent', 'other'))
      and (status is null or status in ('ok', 'error', 'denied', 'timeout'))
      and (error_class is null or error_class in
           ('tool_error', 'invalid_args', 'not_found', 'permission', 'timeout', 'rate_limited',
            'network', 'interrupted', 'other'))
      and (duration_ms is null or duration_ms between 0 and 86400000)
      and (tokens_in is null or tokens_in between 0 and 100000000)
      and (tokens_out is null or tokens_out between 0 and 100000000)
      and (target_kind is null or target_kind in
           ('file', 'dir', 'url', 'host', 'repo', 'agent', 'skill', 'mcp', 'command', 'pattern', 'none'))
      and (args_sha256 is null or args_sha256 ~ '^[0-9a-f]{64}$')
      and (result_sha256 is null or result_sha256 ~ '^[0-9a-f]{64}$')
    );
  end if;
  -- An ok step has no error class; a failed step names one (the tma-trajectory/1 validator rule).
  if not exists (select 1 from pg_constraint where conname = 'run_actions_status_error_check') then
    alter table public.run_actions add constraint run_actions_status_error_check check (
      status is null or (status = 'ok') = (error_class is null)
    );
  end if;
end $$;

comment on column public.run_actions.target is
  'Hosted run: workspace-relative path, shell command or pattern, max 300 chars (the run content stays on the runner). Uploaded tma-trajectory/1 step: target_redacted, max 120 chars of the redaction charset (plan 20261112-tma-c4-result-store-trajectory-upload ADR-2).';
comment on column public.run_actions.status is
  'tma-trajectory/1 step status (ok | error | denied | timeout). Null on rows written before 0023.';
comment on column public.run_actions.args_sha256 is
  'sha256 of the canonical tool arguments; the arguments stay on the host.';
comment on column public.run_actions.result_sha256 is
  'sha256 of the tool result; the result stays on the host.';

commit;
