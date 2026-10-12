-- 0011_agent_requires.sql — agent requirements for the task tool environment (U28, ADR-11,
-- plan 20261012-itera-testmyagent-ui-refactor). Numbers: 0009_user_tasks (U19), 0010 (U27).
--
-- A task declares its tool environment in task.json (environment.tools.builtin, tools.mcp[],
-- run_egress, secrets, resources: packages/contracts/schemas/task.schema.json). It lives in the
-- task contract (task_versions.contract), so no task column is added here.
-- An agent declares what it needs: agents.requires, the chip field of screen 02, stored on the
-- agent (not parsed from AGENTS.md). Entries: 'mcp:<server>' or 'tool:<builtin>'.
-- The API refuses an incompatible agent/task pair before the quote (no payment).
--
-- Same posture as 0000–0008: RLS on, no policies, the API connects as itera_api_service.
-- No DB function, no trigger: the compatibility check lives in packages/contracts + apps/api.
-- Idempotent (safe to re-run). One transaction.

begin;

alter table public.agents add column if not exists requires text[] not null default '{}';

alter table public.agents drop constraint if exists agents_requires_check;
alter table public.agents add constraint agents_requires_check check (
  cardinality(requires) <= 20
  and array_to_string(requires, ' ') ~ '^((mcp:[a-z0-9][a-z0-9_-]{0,31}|tool:(read|write|edit|bash|search|list|todo))( |$))*$'
);

comment on column public.agents.requires is
  'U28 / ADR-11: what the agent needs from a task tool environment. mcp:<server> | tool:<builtin>. Checked against task.json environment.tools before the quote.';

-- The curated webhook-ledger seed (0007) stored a partial contract. Give its v1 the environment
-- of benchmarks/webhook-ledger/task.json (built-in tools only): the API image does not ship
-- benchmarks/ (#71), so task_versions.contract is where the API reads the tool environment.
update public.task_versions tv
   set contract = tv.contract || jsonb_build_object('environment', jsonb_build_object(
         'dir', 'environment',
         'tools', jsonb_build_object('builtin', jsonb_build_array('read', 'write', 'edit', 'bash', 'search', 'list', 'todo'), 'mcp', jsonb_build_array()),
         'run_egress', jsonb_build_array('model-gateway'),
         'secrets', jsonb_build_array(),
         'resources', jsonb_build_object('cpus', 2, 'memory_mb', 2048, 'pids', 512)))
  from public.tasks t
 where t.id = tv.task_id and tv.source = 'curated' and tv.pack_id = 'webhook-ledger'
   and not (tv.contract ? 'environment');

-- Column privileges follow the table grant; repeated so this file stands alone (same as 0005/0006).
grant select, insert, update, delete on public.agents to itera_api_service;
alter table public.agents enable row level security;

commit;
