-- ============================================================
--  Aria OS — complete Supabase schema
-- ------------------------------------------------------------
--  Run this ONCE, whole, in the Supabase SQL editor.
--  It is idempotent: running it again is safe and changes nothing.
--
--  LOGIN IS BY MOBILE NUMBER. There is no email in the interface.
--  Internally a number becomes <digits>@ariaos.app so ordinary
--  email+password auth can carry it — no SMS provider, no OTP,
--  works on the free tier. See js/supabase.js for the why.
--
--  BEFORE YOU RUN IT: set the admin mobile in gf_admin_emails()
--  below, and set the same number in js/admin.js (window.GF_ADMIN).
--  The server is authoritative — the JS copy is only a cosmetic
--  hint so an admin never sees a flash of "access denied".
--
--  The security model, in one paragraph:
--    Every table has RLS. Every privileged operation goes through a
--    SECURITY DEFINER function that re-checks gf_is_admin() itself,
--    and those functions have EXECUTE revoked from anon. A BEFORE
--    UPDATE trigger on gf_profiles reverts the privileged columns
--    for anyone who is not an admin, and the only way past it is a
--    transaction-local GUC that the trusted functions set. So a user
--    who edits the JavaScript in their browser gains nothing.
-- ============================================================


-- ============================================================
-- 0 · ADMIN IDENTITY
-- ============================================================

-- Everyone signs in with a mobile number. Internally that number becomes
-- <digits>@ariaos.app, so the admin list is a list of those addresses.
-- To make 9812345678 an admin, add '9812345678@ariaos.app' here.
create or replace function public.gf_admin_emails()
returns text[] language sql immutable as $$
  select array[
    '9873393559@ariaos.app'        -- << admin mobile 9873393559
  ]::text[];
$$;

-- Convenience: is this MOBILE NUMBER an admin?
create or replace function public.gf_is_admin_phone(p_phone text)
returns boolean language sql immutable set search_path = public as $$
  select lower(regexp_replace(coalesce(p_phone,''), '\D', '', 'g') || '@ariaos.app')
         = any (public.gf_admin_emails());
$$;

create or replace function public.gf_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = any (public.gf_admin_emails());
$$;

create or replace function public.gf_is_admin_email(p_email text)
returns boolean language sql immutable set search_path = public as $$
  select lower(coalesce(p_email, '')) = any (public.gf_admin_emails());
$$;


-- ============================================================
-- 1 · STATE — one JSON row per user, the whole app in a blob
-- ============================================================

create table if not exists public.gf_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.gf_state enable row level security;

drop policy if exists "state read"   on public.gf_state;
drop policy if exists "state insert" on public.gf_state;
drop policy if exists "state update" on public.gf_state;
drop policy if exists "state delete" on public.gf_state;

-- Deliberately NOT readable by the admin. The admin manages ACCESS,
-- not what anyone said to their girlfriend at 2am.
create policy "state read"   on public.gf_state for select using ( auth.uid() = user_id );
create policy "state insert" on public.gf_state for insert with check ( auth.uid() = user_id );
create policy "state update" on public.gf_state for update using ( auth.uid() = user_id )
                                                with check ( auth.uid() = user_id );
create policy "state delete" on public.gf_state for delete using ( auth.uid() = user_id or public.gf_is_admin() );


-- ============================================================
-- 2 · PROFILES — who exists and what they are entitled to
-- ============================================================

create table if not exists public.gf_profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  email         text,                                  -- the internal <digits>@ariaos.app address
  phone         text,                                  -- the real mobile number, for display and search
  name          text,
  status        text        not null default 'trial',    -- trial | active | blocked
  trial_ends_at timestamptz not null default (now() + interval '7 days'),
  access_until  timestamptz,                             -- null + status='active' => lifetime
  coupon_used   text,
  note          text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists gf_profiles_status_idx on public.gf_profiles (status);
create index if not exists gf_profiles_phone_idx  on public.gf_profiles (phone);

-- older installs: add the column without touching anything else
alter table public.gf_profiles add column if not exists phone text;

alter table public.gf_profiles enable row level security;

drop policy if exists "profiles read"   on public.gf_profiles;
drop policy if exists "profiles insert" on public.gf_profiles;
drop policy if exists "profiles update" on public.gf_profiles;
drop policy if exists "profiles delete" on public.gf_profiles;

create policy "profiles read"   on public.gf_profiles for select using ( auth.uid() = user_id or public.gf_is_admin() );
create policy "profiles insert" on public.gf_profiles for insert with check ( auth.uid() = user_id or public.gf_is_admin() );
create policy "profiles update" on public.gf_profiles for update using ( auth.uid() = user_id or public.gf_is_admin() );
create policy "profiles delete" on public.gf_profiles for delete using ( public.gf_is_admin() );

-- The key defence. A user may update their own row (name, note) but the
-- privileged columns are silently reverted unless the caller is an admin
-- or a trusted RPC has set the transaction-local bypass.
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
  end if;
  return new;
end $$;

drop trigger if exists gf_guard_profile_trg on public.gf_profiles;
create trigger gf_guard_profile_trg
  before update on public.gf_profiles
  for each row execute function public.gf_guard_profile();


-- ============================================================
-- 3 · COUPONS + redemption audit
-- ============================================================

create table if not exists public.gf_coupons (
  code       text primary key,
  days       int         not null default 30,    -- 0 or less => lifetime
  max_uses   int         not null default 1,     -- 0 or less => unlimited
  used_count int         not null default 0,
  active     boolean     not null default true,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.gf_coupons enable row level security;
drop policy if exists "coupons admin all" on public.gf_coupons;
-- Users get NO direct policy at all. Redemption happens only through the RPC.
create policy "coupons admin all" on public.gf_coupons
  for all using ( public.gf_is_admin() ) with check ( public.gf_is_admin() );

create table if not exists public.gf_coupon_uses (
  id      bigserial primary key,
  code    text not null,
  user_id uuid not null,
  email   text,
  used_at timestamptz not null default now()
);

create unique index if not exists gf_coupon_uses_once on public.gf_coupon_uses (user_id, upper(code));

alter table public.gf_coupon_uses enable row level security;
drop policy if exists "coupon uses read" on public.gf_coupon_uses;
create policy "coupon uses read" on public.gf_coupon_uses
  for select using ( public.gf_is_admin() or auth.uid() = user_id );


-- ============================================================
-- 4 · CONFIG — a single row, id = 1
-- ============================================================

create table if not exists public.gf_config (
  id            int primary key default 1,
  provider      text        not null default 'gemini',   -- gemini|openai|claude|groq|deepseek|openrouter|offline
  api_key       text        not null default '',         -- raw key, OR the {"v":1,"keys":[...]} envelope
  model         text        not null default '',
  trial_days    int         not null default 7,
  announcement  text        not null default '',
  nsfw_enabled  boolean     not null default true,
  updated_at    timestamptz not null default now(),
  constraint gf_config_single check (id = 1)
);

insert into public.gf_config (id) values (1) on conflict (id) do nothing;

-- older installs: add the column without touching anything else
alter table public.gf_config add column if not exists nsfw_enabled boolean not null default true;

alter table public.gf_config enable row level security;
drop policy if exists "config admin all" on public.gf_config;
create policy "config admin all" on public.gf_config
  for all using ( public.gf_is_admin() ) with check ( public.gf_is_admin() );


-- ============================================================
-- 5 · PERSONAS — personalities the admin publishes to everyone
-- ============================================================

create table if not exists public.gf_personas (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null,
  emoji         text        not null default '💜',
  family        text        not null default 'romance',
  label         text        not null default '',
  blurb         text        not null default '',
  spec          jsonb       not null default '{}'::jsonb,
  system_prompt text        not null default '',
  active        boolean     not null default true,
  created_at    timestamptz not null default now()
);

alter table public.gf_personas enable row level security;

drop policy if exists "personas read"      on public.gf_personas;
drop policy if exists "personas admin all" on public.gf_personas;

-- everyone signed in can read the live ones; only the admin writes
create policy "personas read" on public.gf_personas
  for select using ( active or public.gf_is_admin() );
create policy "personas admin all" on public.gf_personas
  for all using ( public.gf_is_admin() ) with check ( public.gf_is_admin() );


-- ============================================================
-- 6 · AUDIT LOG
-- ============================================================

create table if not exists public.gf_admin_log (
  id     bigserial primary key,
  actor  text,
  target uuid,
  action text,
  days   int,
  at     timestamptz not null default now()
);

alter table public.gf_admin_log enable row level security;
drop policy if exists "admin log read" on public.gf_admin_log;
create policy "admin log read" on public.gf_admin_log for select using ( public.gf_is_admin() );


-- ============================================================
-- 7 · THE ACCESS PREDICATE
-- ============================================================

create or replace function public.gf_has_access(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when r.user_id is null                                    then false
    when public.gf_is_admin_email(r.email)                    then true
    when r.status = 'blocked'                                 then false
    when r.status = 'active' and r.access_until is null       then true
    when r.access_until is not null and r.access_until > now() then true
    when r.trial_ends_at > now()                              then true
    else false
  end
  from (select * from public.gf_profiles where user_id = p_user) r;
$$;


-- ============================================================
-- 8 · BOOTSTRAP — upsert on login, return everything the client needs
-- ============================================================

create or replace function public.gf_bootstrap(p_name text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := auth.jwt() ->> 'email';
  v_phone text := split_part(coalesce(v_email, ''), '@', 1);
  v_days  int;
  r       public.gf_profiles%rowtype;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not signed in');
  end if;

  select trial_days into v_days from public.gf_config where id = 1;
  v_days := coalesce(v_days, 7);

  perform set_config('gf.bypass', '1', true);

  insert into public.gf_profiles (user_id, email, phone, name, trial_ends_at)
  values (v_uid, v_email, nullif(v_phone, ''), nullif(p_name, ''), now() + (v_days || ' days')::interval)
  on conflict (user_id) do update
    set email        = coalesce(excluded.email, public.gf_profiles.email),
        phone        = coalesce(public.gf_profiles.phone, excluded.phone),
        name         = coalesce(nullif(p_name, ''), public.gf_profiles.name),
        last_seen_at = now();

  select * into r from public.gf_profiles where user_id = v_uid;

  return json_build_object(
    'ok', true,
    'user_id', r.user_id, 'email', r.email, 'phone', r.phone, 'name', r.name,
    'status', r.status, 'trial_ends_at', r.trial_ends_at, 'access_until', r.access_until,
    'created_at', r.created_at, 'coupon_used', r.coupon_used,
    'is_admin',    public.gf_is_admin(),
    'has_access',  public.gf_has_access(v_uid),
    'server_time', now()
  );
end $$;


-- ============================================================
-- 9 · GET CONFIG — the entitlement-gated key handout
-- ============================================================

create or replace function public.gf_get_config()
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  c     public.gf_config%rowtype;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not signed in');
  end if;

  -- this is the real gate. Defeat the JavaScript lock all you like:
  -- without access, no key comes back and the app has no AI.
  if not (public.gf_is_admin() or public.gf_has_access(v_uid)) then
    return json_build_object('ok', false, 'error', 'no access');
  end if;

  select * into c from public.gf_config where id = 1;

  return json_build_object(
    'ok', true,
    'provider', c.provider, 'api_key', c.api_key, 'model', c.model,
    'announcement', c.announcement, 'nsfw_enabled', c.nsfw_enabled,
    'updated_at', c.updated_at
  );
end $$;


-- ============================================================
-- 10 · REDEEM A COUPON — the whole transaction, server side
-- ============================================================

create or replace function public.gf_redeem_coupon(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := auth.jwt() ->> 'email';
  v_code  text := upper(trim(coalesce(p_code, '')));
  c       public.gf_coupons%rowtype;
  r       public.gf_profiles%rowtype;
  v_base  timestamptz;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'Please log in first.'); end if;
  if v_code = ''   then return json_build_object('ok', false, 'error', 'Enter a coupon code.');  end if;

  -- FOR UPDATE: without the row lock, two people redeeming the last use of a
  -- coupon at the same moment both succeed.
  select * into c from public.gf_coupons where upper(code) = v_code for update;

  if c.code is null then return json_build_object('ok', false, 'error', 'That coupon does not exist.'); end if;
  if not c.active  then return json_build_object('ok', false, 'error', 'This coupon has been disabled.'); end if;
  if c.max_uses > 0 and c.used_count >= c.max_uses then
    return json_build_object('ok', false, 'error', 'This coupon has already been fully used.');
  end if;
  if exists (select 1 from public.gf_coupon_uses u where u.user_id = v_uid and upper(u.code) = v_code) then
    return json_build_object('ok', false, 'error', 'You have already used this coupon.');
  end if;

  select * into r from public.gf_profiles where user_id = v_uid;
  if r.user_id is null then
    return json_build_object('ok', false, 'error', 'Profile missing — close and reopen the app.');
  end if;

  perform set_config('gf.bypass', '1', true);

  if c.days <= 0 then
    update public.gf_profiles
      set status = 'active', access_until = null, coupon_used = c.code
      where user_id = v_uid;
  else
    -- stack on top of what they already have, but never back-date
    v_base := greatest(coalesce(r.access_until, now()), now());
    update public.gf_profiles
      set status = 'active', access_until = v_base + (c.days || ' days')::interval, coupon_used = c.code
      where user_id = v_uid;
  end if;

  update public.gf_coupons set used_count = used_count + 1 where code = c.code;
  insert into public.gf_coupon_uses (code, user_id, email) values (c.code, v_uid, v_email);

  select * into r from public.gf_profiles where user_id = v_uid;

  return json_build_object(
    'ok', true, 'days', c.days, 'status', r.status, 'access_until', r.access_until,
    'message', case when c.days <= 0
                    then 'Lifetime access unlocked 🎉'
                    else c.days || ' days unlocked 🎉' end
  );
end $$;


-- ============================================================
-- 11 · ADMIN: set access
-- ============================================================

create or replace function public.gf_admin_set_access(
  p_user   uuid,
  p_action text,               -- grant | extend | unlimited | block | unblock | reset_trial | expire
  p_days   int default 30
) returns json language plpgsql security definer set search_path = public as $$
declare
  r      public.gf_profiles%rowtype;
  v_base timestamptz;
begin
  if not public.gf_is_admin() then
    return json_build_object('ok', false, 'error', 'Admins only.');
  end if;

  select * into r from public.gf_profiles where user_id = p_user;
  if r.user_id is null then return json_build_object('ok', false, 'error', 'User not found.'); end if;

  perform set_config('gf.bypass', '1', true);

  if p_action = 'grant' then
    update public.gf_profiles
      set status = 'active', access_until = now() + (p_days || ' days')::interval
      where user_id = p_user;

  elsif p_action = 'extend' then
    v_base := greatest(coalesce(r.access_until, now()), now());
    update public.gf_profiles
      set status = 'active', access_until = v_base + (p_days || ' days')::interval
      where user_id = p_user;

  elsif p_action = 'unlimited' then
    update public.gf_profiles set status = 'active', access_until = null where user_id = p_user;

  elsif p_action = 'block' then
    update public.gf_profiles set status = 'blocked' where user_id = p_user;

  elsif p_action = 'unblock' then
    update public.gf_profiles
      set status = case when coalesce(access_until, trial_ends_at) > now() then 'active' else 'trial' end
      where user_id = p_user;

  elsif p_action = 'reset_trial' then
    update public.gf_profiles
      set status = 'trial', access_until = null,
          trial_ends_at = now() + (greatest(p_days, 1) || ' days')::interval
      where user_id = p_user;

  elsif p_action = 'expire' then
    update public.gf_profiles
      set status = 'trial', access_until = null, trial_ends_at = now() - interval '1 minute'
      where user_id = p_user;

  else
    return json_build_object('ok', false, 'error', 'Unknown action.');
  end if;

  begin
    insert into public.gf_admin_log (actor, target, action, days)
    values (auth.jwt() ->> 'email', p_user, p_action, p_days);
  exception when undefined_table then null;
  end;

  select * into r from public.gf_profiles where user_id = p_user;

  return json_build_object(
    'ok', true, 'status', r.status, 'access_until', r.access_until,
    'trial_ends_at', r.trial_ends_at, 'has_access', public.gf_has_access(p_user)
  );
end $$;


-- ============================================================
-- 12 · ADMIN: list users
-- ============================================================

create or replace function public.gf_admin_users()
returns json language plpgsql security definer set search_path = public as $$
declare v json;
begin
  if not public.gf_is_admin() then
    return json_build_object('ok', false, 'error', 'Admins only.');
  end if;

  select coalesce(json_agg(t order by t.created_at desc), '[]'::json) into v
  from (
    select p.user_id, p.email, p.phone, p.name, p.status, p.trial_ends_at, p.access_until,
           p.coupon_used, p.note, p.created_at, p.last_seen_at,
           public.gf_has_access(p.user_id) as has_access,
           (select count(*) from public.gf_state s where s.user_id = p.user_id) > 0 as has_data
    from public.gf_profiles p
  ) t;

  return json_build_object('ok', true, 'users', v, 'server_time', now());
end $$;


-- ============================================================
-- 12b · ADMIN: seed a profile for an account the admin just created
--       The browser cannot create auth users with the anon key, so
--       admin.js signs the new person up on a detached client and
--       then calls this to give them a profile and their days.
--       Without this the profile would not exist until their first
--       login, and the admin could not grant them anything yet.
-- ============================================================

create or replace function public.gf_admin_create_profile(
  p_user  uuid,
  p_phone text,
  p_name  text default null,
  p_days  int  default 0        -- 0 = leave them on the normal trial
) returns json language plpgsql security definer set search_path = public as $$
declare
  v_days int;
  r      public.gf_profiles%rowtype;
begin
  if not public.gf_is_admin() then
    return json_build_object('ok', false, 'error', 'Admins only.');
  end if;
  if p_user is null then
    return json_build_object('ok', false, 'error', 'No user id given.');
  end if;

  select trial_days into v_days from public.gf_config where id = 1;
  v_days := coalesce(v_days, 7);

  perform set_config('gf.bypass', '1', true);

  insert into public.gf_profiles (user_id, email, phone, name, status, trial_ends_at, access_until)
  values (
    p_user,
    regexp_replace(coalesce(p_phone,''), '\D', '', 'g') || '@ariaos.app',
    regexp_replace(coalesce(p_phone,''), '\D', '', 'g'),
    nullif(p_name, ''),
    case when p_days > 0 then 'active' else 'trial' end,
    now() + (v_days || ' days')::interval,
    case when p_days > 0 then now() + (p_days || ' days')::interval else null end
  )
  on conflict (user_id) do update
    set phone        = coalesce(excluded.phone, public.gf_profiles.phone),
        name         = coalesce(excluded.name,  public.gf_profiles.name),
        status       = excluded.status,
        access_until = excluded.access_until;

  begin
    insert into public.gf_admin_log (actor, target, action, days)
    values (auth.jwt() ->> 'email', p_user, 'create_user', p_days);
  exception when undefined_table then null;
  end;

  select * into r from public.gf_profiles where user_id = p_user;

  return json_build_object(
    'ok', true, 'user_id', r.user_id, 'phone', r.phone,
    'status', r.status, 'access_until', r.access_until,
    'has_access', public.gf_has_access(p_user)
  );
end $$;


-- ============================================================
-- 13 · HARDENING — revoke from anon, grant only what is needed
-- ============================================================

-- Loop over pg_proc so a signature mismatch can never abort the script.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('gf_admin_set_access','gf_admin_users','gf_admin_create_profile',
                        'gf_get_config','gf_redeem_coupon','gf_bootstrap','gf_has_access')
  loop
    execute format('revoke all on function %s from anon, public', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['gf_config','gf_coupons','gf_profiles','gf_admin_log','gf_personas'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('revoke all on table public.%I from anon, authenticated', t);
    if t in ('gf_admin_log') then
      execute format('grant select on table public.%I to authenticated', t);
    elsif t = 'gf_personas' then
      execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    else
      execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    end if;
  end loop;
end $$;

grant usage, select on all sequences in schema public to authenticated;


-- ============================================================
-- 14 · RELOAD THE API CACHE
--      Without this, the new functions 404 with
--      "not found in the schema cache".
-- ============================================================

notify pgrst, 'reload schema';


-- ============================================================
-- 15 · VERIFY — you should get 12 rows back
-- ============================================================

select proname as installed_function
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'gf\_%'
order by proname;
