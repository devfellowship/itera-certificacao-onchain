-- 0012_task_profile.sql — the public text of a catalog task (U30, plan
-- 20261012-itera-testmyagent-ui-refactor, ADR-11 and designer addendum U32 part 3).
--
-- The public page /tasks/:slug publishes the stable rules of a task: goal, "done when", the
-- instruction, the limits and the verifier. They live in the task version's contract (jsonb), like
-- the tool environment of 0011. No column, no table, no function, no trigger. The API image does not
-- ship benchmarks/ (#71), so task_versions.contract is where the API reads them.
--
-- Only the webhook-ledger v1 is runnable today, so only it gets a profile. The other eight catalog
-- tasks have no pack yet; their page shows the empty copy.
-- Idempotent (safe to re-run): the keys are merged into the existing contract.

begin;

update public.task_versions tv
   set contract = tv.contract || jsonb_build_object(
         'est_minutes', 6,
         'agent',    jsonb_build_object('timeout_sec', 300),
         'verifier', jsonb_build_object('cmd', jsonb_build_array('npx', 'vitest', 'run', '{tests}', '--reporter=json', '--outputFile={report}'), 'timeout_sec', 120),
         'profile',  jsonb_build_object(
           'goal', 'Make the settlement webhook safe to deliver twice. The endpoint verifies the HMAC signature, applies each event once, and never moves a settled event back to pending.',
           'done_when', jsonb_build_array(
             'A delivery with a missing or wrong signature is rejected.',
             'A second delivery of the same event id changes nothing.',
             'A settled event never returns to pending.',
             'The existing public tests still pass.'),
           'instruction', 'Fix POST /events. Verify the HMAC-SHA256 signature over the raw request body using the supplied fixture key. Process each event ID at most once. A settled event must not move back to pending. Preserve the response contract and existing tests. Do not edit any file under tests/ -- your fix is graded by hidden tests mounted after your patch is frozen, and any change under tests/ is out of scope and will be rejected.',
           'repository', jsonb_build_object('repo', 'devfellowship/itera-certificacao-onchain', 'path', 'benchmarks/webhook-ledger/environment'),
           'public_tests_count', 3))
  from public.tasks t
 where t.id = tv.task_id and tv.source = 'curated' and tv.pack_id = 'webhook-ledger'
   and not (tv.contract ? 'profile');

commit;
