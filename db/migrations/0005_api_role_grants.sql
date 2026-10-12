-- 0005_api_role_grants.sql — let the API role reach the tables added by 0002/0003/0004
-- (lane D, plan 20261012-itera-agent-proof-route-change-fixes).
--
-- Found 2026-10-12 in the lane D devnet e2e: the production API connects as `itera_api_service`
-- (BYPASSRLS). 0002/0003/0004 were applied by `itera_tainan_dev`, which now OWNS agent_versions,
-- github_installations, run_actions and proofs, and no grant was given to `itera_api_service`.
-- Result: POST /runs answers 500 (permission denied for table agent_versions), and the GitHub
-- connector, the runner's run_actions and every proof write fail the same way.
--
-- Same privileges `itera_api_service` already holds on public.runs. Idempotent.

grant select, insert, update, delete on public.agent_versions to itera_api_service;
grant select, insert, update, delete on public.github_installations to itera_api_service;
grant select, insert, update, delete on public.run_actions to itera_api_service;
grant select, insert, update, delete on public.proofs to itera_api_service;
grant usage, select on all sequences in schema public to itera_api_service;

-- Same posture as the baseline: RLS on, no policies. The table owner and the BYPASSRLS API role
-- are unaffected; anon/authenticated (PostgREST) get nothing.
alter table public.agent_versions enable row level security;
alter table public.github_installations enable row level security;
