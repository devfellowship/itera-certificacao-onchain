-- 0011_agent_requires.sql — agent requirements for the task tool environment (U28, ADR-11,
-- plan 20261012-itera-testmyagent-ui-refactor). Numbers: 0009_user_tasks (U19), 0010 (U27).
--
-- A task declares its tool environment in task.json (environment.tools.builtin, tools.mcp[],
-- run_egress, secrets, resources: packages/contracts/schemas/task.schema.json). It lives in the
-- task contract (task_versions.contract / the pack's task.json), so no task column is added here.
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

-- Column privileges follow the table grant; repeated so this file stands alone (same as 0005/0006).
grant select, insert, update, delete on public.agents to itera_api_service;
alter table public.agents enable row level security;

commit;
