-- ============================================================
-- UPGRADE — close two privilege-escalation holes on gf_profiles
-- Run ONCE in the Supabase SQL editor on an existing install.
-- Safe to run twice. (New installs: SCHEMA.sql already has it.)
--
-- Before this:
--   1. A signed-in user could INSERT their own gf_profiles row with
--      status = 'active' and no expiry (free lifetime access) before
--      the app's first login call created the normal trial row.
--   2. A signed-in user could UPDATE their own row's `email` to an
--      admin's address. gf_has_access() trusts that column, so it
--      returned true for them forever.
--
-- After this, users can only READ their own profile. Profiles are
-- created by gf_bootstrap() and changed by the admin RPCs, which are
-- SECURITY DEFINER and are not affected by these policies.
-- ============================================================

drop policy if exists "profiles insert" on public.gf_profiles;
drop policy if exists "profiles update" on public.gf_profiles;

create policy "profiles insert" on public.gf_profiles
  for insert with check ( public.gf_is_admin() );

create policy "profiles update" on public.gf_profiles
  for update using ( public.gf_is_admin() ) with check ( public.gf_is_admin() );

-- belt and braces: the trigger also pins email for anyone who is not an admin
create or replace function public.gf_guard_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('gf.bypass', true), '') = '1' then
    return new;
  end if;
  if not public.gf_is_admin() then
    new.status        := old.status;
    new.trial_ends_at := old.trial_ends_at;
    new.access_until  := old.access_until;
    new.coupon_used   := old.coupon_used;
    new.created_at    := old.created_at;
    new.user_id       := old.user_id;
    new.phone         := old.phone;
    new.email         := old.email;
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';

-- check: should list exactly 4 policies for gf_profiles
-- select policyname, cmd from pg_policies where tablename = 'gf_profiles' order by cmd;
