-- 0015_profile_avatars.sql — user profile picture (U36, plan 20261012-itera-testmyagent-ui-refactor).
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

alter table public.profiles enable row level security;
grant select, insert, update, delete on public.profiles to itera_api_service;

commit;
