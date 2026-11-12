-- 0024_eval_summary_steps_grader_meta.sql — the task summary of a test case, the tma-trajectory/2 step columns, and
-- the proof, calibration, note and author of a grader version and the reason code and labeler of a grader result
-- (plan 20261112-tma-c4-result-store-trajectory-upload, tasks T9, T10 and T11; parent plan
-- 20261112-tma-eval-studio-real-trace-evals ADR-27 and ADR-28, Q-T16 = A).
--
-- Adds (every column is nullable; existing rows are untouched and keep null):
--   eval_cases.task_summary        jsonb {before, expected}: short human-written text, at most 280 characters per
--                                  field, the label charset, at most 2048 bytes (T9, Q-T16 = A). No `outcome`:
--                                  the outcome describes one run and stays on the trace, on the host (ADR-27).
--   run_actions.step_kind          the closed step kind of a tma-trajectory/2 step: read, search, write, test, mcp,
--                                  shell, agent, other (T10; S9 needs it, and a test call cannot be told from
--                                  another shell call without its command).
--   run_actions.started_ms         the start of the step, in ms from the start of the run (T10; S3 waterfall).
--   run_actions.turn_origin        who started the turn of the step: human, agent or system (T10).
--   grader_versions.proof_caught,
--   grader_versions.proof_total    the mutation proof of the version: planted bugs caught, of planted (T11, S10).
--   grader_versions.calibration    jsonb, a judge only: the label counts and the 2x2 table of the test split
--                                  {n_labels, n_test, tp, fn, tn, fp, realigned_at} (T11, S11a). Integers and one
--                                  date, no text.
--   grader_versions.note           at most 60 characters, the label charset (T11, the Versions tab of S10a, S11a).
--   grader_versions.author         the actor key of the author of the version (T11).
--   grader_results.reason_code     the closed reason of a label: wrong_sha, no_check, partial, other (T11, S13 chips).
--   grader_results.labeler         the actor key of the author of the label (T11, S13).
--
-- An actor key is a lower-case key (a slug or a principal id): ^[a-z0-9][a-z0-9_.:-]{0,63}$. No e-mail address and no
-- display name.
--
-- Not here: no back-fill of the step kind of the rows written before this file (a separate data step), and no
-- verdict, route, label-queue or experiment table.
--
-- Same posture as 0000-0023: RLS stays on with no policies; the grants of 0023 cover the new columns (grader_results
-- stays without UPDATE for the API role). No DB function, no trigger, no data change. The CHECKs only use built-in
-- operators. One transaction. Idempotent: a second apply changes 0 rows.
-- Production (mkfnbsnyvfkkfcjfpkxz): applied on merge by .github/workflows/db-apply.yml (Q-C4-1 = C). The merge of this
-- file is a human merge (safe-admin-merge protected path db/migrations/**).

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------------------------
-- eval_cases.task_summary (T9)
alter table public.eval_cases add column if not exists task_summary jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'eval_cases_task_summary_check') then
    alter table public.eval_cases add constraint eval_cases_task_summary_check check (
      task_summary is null or (
        jsonb_typeof(task_summary) = 'object'
        and octet_length(task_summary::text) <= 2048
        -- Only `before` and `expected`; `outcome` (and any other key) is refused.
        and (task_summary - 'before' - 'expected') = '{}'::jsonb
        and coalesce(jsonb_typeof(task_summary -> 'before'), 'null') in ('string', 'null')
        and coalesce(jsonb_typeof(task_summary -> 'expected'), 'null') in ('string', 'null')
        and coalesce(char_length(task_summary ->> 'before'), 1) between 1 and 280
        and coalesce(char_length(task_summary ->> 'expected'), 1) between 1 and 280
        and coalesce(task_summary ->> 'before', '') ~ '^[A-Za-z0-9 .,:;/()+_%$=&''#-]*$'
        and coalesce(task_summary ->> 'expected', '') ~ '^[A-Za-z0-9 .,:;/()+_%$=&''#-]*$'
      )
    );
  end if;
end $$;

comment on column public.eval_cases.task_summary is
  'The task summary of the test case: {before, expected}, short human-written text, at most 280 characters per field in the label charset (parent plan ADR-27, ADR-28, Q-T16 = A). The outcome of a run is never stored here. Null = not given.';

-- ---------------------------------------------------------------------------------------------
-- run_actions: the tma-trajectory/2 step columns (T10)
alter table public.run_actions add column if not exists step_kind   text;
alter table public.run_actions add column if not exists started_ms  int;
alter table public.run_actions add column if not exists turn_origin text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'run_actions_trajectory_v2_check') then
    alter table public.run_actions add constraint run_actions_trajectory_v2_check check (
      (step_kind is null or step_kind in ('read', 'search', 'write', 'test', 'mcp', 'shell', 'agent', 'other'))
      and (started_ms is null or started_ms between 0 and 86400000)
      and (turn_origin is null or turn_origin in ('human', 'agent', 'system'))
    );
  end if;
end $$;

comment on column public.run_actions.step_kind is
  'tma-trajectory/2 step kind: read | search | write | test | mcp | shell | agent | other. The uploader classifies the call on its host (it sees the command); the hosted runner maps the opencode tool and command. Null on rows written before 0024 and on tma-trajectory/1 uploads.';
comment on column public.run_actions.started_ms is
  'tma-trajectory/2: the start of the step in ms from the start of the run. Null when not reported.';
comment on column public.run_actions.turn_origin is
  'tma-trajectory/2: who started the turn of the step (human | agent | system). Null when not reported.';

-- ---------------------------------------------------------------------------------------------
-- grader_versions: proof, calibration, note, author (T11)
alter table public.grader_versions add column if not exists proof_caught smallint;
alter table public.grader_versions add column if not exists proof_total  smallint;
alter table public.grader_versions add column if not exists calibration  jsonb;
alter table public.grader_versions add column if not exists note         text;
alter table public.grader_versions add column if not exists author       text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'grader_versions_proof_check') then
    alter table public.grader_versions add constraint grader_versions_proof_check check (
      (proof_caught is null) = (proof_total is null)
      and (proof_total is null or (proof_total between 1 and 1000 and proof_caught between 0 and proof_total))
    );
  end if;
  -- A judge only. The keys are fixed and the six counts are numbers; the API checks that they are integers,
  -- that tp + fn + tn + fp = n_test and that n_test <= n_labels.
  if not exists (select 1 from pg_constraint where conname = 'grader_versions_calibration_check') then
    alter table public.grader_versions add constraint grader_versions_calibration_check check (
      calibration is null or (
        kind = 'judge'
        and jsonb_typeof(calibration) = 'object'
        and octet_length(calibration::text) <= 512
        and calibration ?& array['n_labels', 'n_test', 'tp', 'fn', 'tn', 'fp', 'realigned_at']
        and (calibration - array['n_labels', 'n_test', 'tp', 'fn', 'tn', 'fp', 'realigned_at']) = '{}'::jsonb
        and jsonb_typeof(calibration -> 'n_labels') = 'number'
        and jsonb_typeof(calibration -> 'n_test') = 'number'
        and jsonb_typeof(calibration -> 'tp') = 'number'
        and jsonb_typeof(calibration -> 'fn') = 'number'
        and jsonb_typeof(calibration -> 'tn') = 'number'
        and jsonb_typeof(calibration -> 'fp') = 'number'
        and jsonb_typeof(calibration -> 'realigned_at') in ('string', 'null')
        and coalesce(calibration ->> 'realigned_at', '2000-01-01') ~ '^\d{4}-\d{2}-\d{2}$'
      )
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'grader_versions_note_check') then
    alter table public.grader_versions add constraint grader_versions_note_check check (
      note is null or (char_length(note) between 1 and 60 and note ~ '^[A-Za-z0-9 .,:;/()+_%$=&''#-]*$')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'grader_versions_author_check') then
    alter table public.grader_versions add constraint grader_versions_author_check check (
      author is null or author ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'
    );
  end if;
end $$;

comment on column public.grader_versions.proof_caught is
  'The mutation proof of this version: how many planted bugs it caught (with proof_total). Null = no proof reported.';
comment on column public.grader_versions.proof_total is
  'The mutation proof of this version: how many bugs were planted (1-1000).';
comment on column public.grader_versions.calibration is
  'A judge only: {n_labels, n_test, tp, fn, tn, fp, realigned_at} of its test split (S11a 2x2 table). Counts and one date, no text. tpr and tnr stay in their own columns.';
comment on column public.grader_versions.note is
  'The version note (at most 60 characters, the label charset).';
comment on column public.grader_versions.author is
  'The actor key of the author of the version (a slug or a principal id; never an e-mail address).';

-- ---------------------------------------------------------------------------------------------
-- grader_results: reason code and labeler (T11)
alter table public.grader_results add column if not exists reason_code text;
alter table public.grader_results add column if not exists labeler     text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'grader_results_label_check') then
    alter table public.grader_results add constraint grader_results_label_check check (
      (reason_code is null or reason_code in ('wrong_sha', 'no_check', 'partial', 'other'))
      and (labeler is null or labeler ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$')
    );
  end if;
end $$;

comment on column public.grader_results.reason_code is
  'The closed reason of a label (S13 chips): wrong_sha (checked the wrong SHA) | no_check | partial | other. Null = none.';
comment on column public.grader_results.labeler is
  'The actor key of the author of the label (a slug or a principal id; never an e-mail address). Null = not reported.';

commit;
