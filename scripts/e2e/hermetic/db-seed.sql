-- Hermetic web3 e2e guard (T14): test fixtures, applied AFTER db/migrations/*.sql on the job's own
-- Postgres. Test database only: never run this on a real project.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v wallet=<base58> -v model=<model id> -f db-seed.sql
--
-- 1. The model catalog counts as synced (the API runs with ITERA_MODELS_SYNC=off: no OpenRouter call).
-- 2. One agent owned by the e2e wallet, with a pinned agent version. In production the GitHub App
--    writes this row (POST /agents); CI has no App credential, and the guard tests the web3 flow
--    (SIWS, quote, Solana Pay, run, attestation, verify), not the App install. The driver gets the
--    agent id with --agent-id and skips the GitHub steps.

update public.models set synced_at = now(), supports_tools = true;

insert into public.vendors (display_name) values ('wallet:' || :'wallet');

insert into public.agents
  (vendor_id, name, endpoint_url, owner_wallet, gh_installation_id, repo_full_name, agent_path, model, connector,
   slug, description, visibility, status, branch, pinned_commit, model_release, listed_at, repo_source)
select v.id, 'testmyagent-demo-agent', 'github://devfellowship/testmyagent-demo-agent/.', :'wallet', 170661046,
       'devfellowship/testmyagent-demo-agent', '.', :'model', 'github',
       'e2e-guard-' || substr(md5(:'wallet'), 1, 10), 'Hermetic e2e guard agent (CI fixture).', 'listed', 'active', 'main',
       'e2e0000000000000000000000000000000000001', :'model', now(), 'sample'
  from public.vendors v where v.display_name = 'wallet:' || :'wallet';

insert into public.agent_versions (agent_id, commit_sha, files)
select a.id, a.pinned_commit, jsonb_build_array(jsonb_build_object(
         'path', 'AGENTS.md', 'sha', 'e2e0000000000000000000000000000000000002', 'size', 74, 'encoding', 'utf-8',
         'content', E'# E2E guard agent\n\nRead the task, fix the code in src/, run the public tests.\n'))
  from public.agents a where a.owner_wallet = :'wallet';

select 'AGENT_ID=' || a.id from public.agents a where a.owner_wallet = :'wallet';
