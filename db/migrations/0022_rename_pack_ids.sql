-- 0022_rename_pack_ids.sql — the production task pack ids become the bundle folder names (plan
-- 20261026-tma-local-runner-and-self-declared-results, Q e9dc0ef2 = A, TG 24074; follows Q 5eff17c7 = A,
-- which renamed the bundles to their catalog slugs):
--   webhook-ledger   -> tsk_webhook_dup
--   helpdesk-refunds -> tsk_helpdesk_refunds
--
-- Renamed (live references to the pack):
--   runs.task_pack_id                     (FK to task_packs)
--   task_versions.pack_id                 (the catalog version of tsk_webhook_dup / tsk_helpdesk_refunds)
--   task_versions.contract profile.repository.path  (benchmarks/<old>/environment -> benchmarks/<new>/...)
--   evaluations.tasks[].packId, payments.tasks[].packId   (the task snapshot of an evaluation / a quote;
--                                         a quote confirmed later creates its runs from it)
-- Kept on purpose (history, signed or graded text): payments.memo (the on-chain memo text),
-- runs.evidence_manifest and runs.provenance (graded evidence), run_actions.target (agent commands),
-- agent_versions.files (agent files). The bundle's own text (task.json name itera/webhook-ledger, public
-- test names "from benchmarks/webhook-ledger/scenario.json") is inside the task digests and stays.
--
-- task_packs: the table is owned by postgres with RLS on and no policy, so a migration cannot write it
-- (0014). The worker registers every bundle under its folder name at boot (curated-packs.ts), so the
-- new rows (tsk_webhook_dup/1, tsk_helpdesk_refunds/1) exist before this runs in production. On a
-- fresh database runs is empty, so the FK is not touched. The old task_packs rows stay (insert only).
--
-- Idempotent: every UPDATE matches only the old ids, so a second run changes 0 rows.
-- Production: applied by hand in one transaction after the worker registered the new rows (Q5 = A).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1. Live references to the pack: runs (FK to task_packs), the catalog version rows.
UPDATE public.runs
   SET task_pack_id = CASE task_pack_id WHEN 'webhook-ledger' THEN 'tsk_webhook_dup' ELSE 'tsk_helpdesk_refunds' END
 WHERE task_pack_id IN ('webhook-ledger', 'helpdesk-refunds');

UPDATE public.task_versions
   SET pack_id = CASE pack_id WHEN 'webhook-ledger' THEN 'tsk_webhook_dup' ELSE 'tsk_helpdesk_refunds' END,
       contract = CASE
         WHEN contract #>> '{profile,repository,path}' LIKE 'benchmarks/' || pack_id || '/%'
         THEN jsonb_set(contract, '{profile,repository,path}', to_jsonb(
                'benchmarks/' || CASE pack_id WHEN 'webhook-ledger' THEN 'tsk_webhook_dup' ELSE 'tsk_helpdesk_refunds' END
                || substr(contract #>> '{profile,repository,path}', length('benchmarks/' || pack_id) + 1)))
         ELSE contract END
 WHERE pack_id IN ('webhook-ledger', 'helpdesk-refunds');

-- 2. The packId inside the task snapshots of evaluations and payments (arrays of objects).
UPDATE public.evaluations e
   SET tasks = (SELECT jsonb_agg(CASE WHEN x ->> 'packId' IN ('webhook-ledger', 'helpdesk-refunds')
                                      THEN jsonb_set(x, '{packId}', to_jsonb(CASE x ->> 'packId' WHEN 'webhook-ledger' THEN 'tsk_webhook_dup' ELSE 'tsk_helpdesk_refunds' END))
                                      ELSE x END ORDER BY ord)
                  FROM jsonb_array_elements(e.tasks) WITH ORDINALITY a(x, ord))
 WHERE jsonb_typeof(e.tasks) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.tasks) x WHERE x ->> 'packId' IN ('webhook-ledger', 'helpdesk-refunds'));

UPDATE public.payments p
   SET tasks = (SELECT jsonb_agg(CASE WHEN x ->> 'packId' IN ('webhook-ledger', 'helpdesk-refunds')
                                      THEN jsonb_set(x, '{packId}', to_jsonb(CASE x ->> 'packId' WHEN 'webhook-ledger' THEN 'tsk_webhook_dup' ELSE 'tsk_helpdesk_refunds' END))
                                      ELSE x END ORDER BY ord)
                  FROM jsonb_array_elements(p.tasks) WITH ORDINALITY a(x, ord))
 WHERE jsonb_typeof(p.tasks) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.tasks) x WHERE x ->> 'packId' IN ('webhook-ledger', 'helpdesk-refunds'));

commit;
