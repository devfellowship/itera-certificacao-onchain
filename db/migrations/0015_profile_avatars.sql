-- 0015_profile_avatars.sql — user and agent pictures (U36, plan 20261012-itera-testmyagent-ui-refactor).
--
-- A user defines a username (the existing `handle` column), a display name and a profile picture.
-- The API resizes the upload to 256×256 WebP (no metadata) and stores it in the public Supabase
-- Storage bucket `avatars`, object key `<wallet>/<sha256-prefix>.webp`. The row keeps the public
-- URL (shown everywhere a user is shown) and the object key (to replace the picture later).
--
-- Same posture as 0000–0014: RLS on, no policies, the API connects as itera_api_service.
-- No DB function, no trigger: validation lives in apps/api. Idempotent. One transaction.

begin;

alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists avatar_key text;

alter table public.profiles drop constraint if exists profiles_avatar_url_https;
alter table public.profiles add constraint profiles_avatar_url_https
  check (avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 500));

alter table public.profiles drop constraint if exists profiles_avatar_key_shape;
alter table public.profiles add constraint profiles_avatar_key_shape
  check (avatar_key is null or avatar_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}/[0-9a-f]{16}\.webp$');

-- Bio (Tainan TG 21099): one optional line, at most 80 characters.
alter table public.profiles add column if not exists bio text;
alter table public.profiles drop constraint if exists profiles_bio_len;
alter table public.profiles add constraint profiles_bio_len check (bio is null or char_length(bio) between 1 and 80);

alter table public.profiles enable row level security;
grant select, insert, update, delete on public.profiles to itera_api_service;

-- Agents have a picture too (Tainan TG 21086): same pipeline, key agents/<agent id>/<hash>.webp.
-- Without one, the web draws a generated tile from the agent id.
alter table public.agents add column if not exists avatar_url text;
alter table public.agents add column if not exists avatar_key text;

alter table public.agents drop constraint if exists agents_avatar_url_https;
alter table public.agents add constraint agents_avatar_url_https
  check (avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 500));

alter table public.agents drop constraint if exists agents_avatar_key_shape;
alter table public.agents add constraint agents_avatar_key_shape
  check (avatar_key is null or avatar_key ~ '^agents/[0-9a-f-]{36}/[0-9a-f]{16}\.webp$');

-- 0005 granted the API role on agents already; repeated here so this file stands alone.
grant select, insert, update, delete on public.agents to itera_api_service;

commit;
