-- Hermetic e2e guard (T14): what the Supabase project has before db/migrations/0000_baseline.sql runs.
-- A plain Postgres lacks these. Test database only: never run this on a real project.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'itera_api_service') then
    create role itera_api_service login bypassrls password 'e2e-local-only';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to itera_api_service;
-- Supabase grants the API role every table of public by default; the migrations rely on it for the
-- baseline tables (vendors, task_packs, ...).
alter default privileges in schema public grant select, insert, update, delete on tables to itera_api_service;
alter default privileges in schema public grant usage, select on sequences to itera_api_service;
