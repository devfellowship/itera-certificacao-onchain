-- 0025_grader_versions_created_by.sql — who first registered a grader version (plan
-- 20261112-tma-c4-result-store-trajectory-upload, task C4-T13 follow-up; coordinator order 2026-11-12).
--
-- Why: grader_versions is a shared registry keyed by (tenant, grader_id, semver, code_sha256). It has no owner
-- column, so the cleanup route (POST /eval-results/cleanup) cannot tell whose row it is. Until this column is
-- filled, the route lets only a TMA admin delete grader versions (PR "grader versions: admin only"). With
-- created_by, a later change can make grader deletes owner-only, like eval_cases and eval_variants.
--
-- Adds ONE nullable column: grader_versions.created_by uuid = the user id of the principal (dfl:<uuid>) whose
-- upload first registered the row. NULL = a row from before this column, or from the hosted runner (no user).
-- No default, no backfill, no function, no trigger. A NULL row stays admin-only for ever.
--
-- Order: apply AFTER 0024 (the applier stops at an out-of-order pending file). 0024 adds grader_versions.author
-- (a display field, free text); created_by is the identity key and is not derived from it.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.grader_versions add column if not exists created_by uuid;

comment on column public.grader_versions.created_by is
  'User id (the uuid of principal dfl:<uuid>) of the upload that first registered this grader version. NULL = created before 0025 or by the hosted runner.';

commit;
