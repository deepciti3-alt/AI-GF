-- ============================================================
-- UPGRADE — 🧠 Train tab + "she texts first"
-- Run this ONCE in the Supabase SQL editor on an existing install.
-- Safe to run twice. (New installs: SCHEMA.sql already has it.)
-- ============================================================

alter table public.gf_config add column if not exists behaviour jsonb not null default '{}'::jsonb;

-- ============================================================
-- 5b · TRAINING — daily notes the admin gives the companions
--      target: 'all' | a built-in id ('romance.priya', 'care.aisha',
--              'drive.riya') | 'name:<lowercase name>' for any other girl
--      kind:   rule | avoid | example | fact | style
--      Users never read this table directly — the active rows reach
--      them inside gf_get_config(), which is gated on access.
-- ============================================================

create table if not exists public.gf_training (
  id          uuid primary key default gen_random_uuid(),
  target      text        not null default 'all',
  kind        text        not null default 'rule',
  prompt      text        not null default '',   -- for examples: what he says
  body        text        not null,              -- the rule / her ideal reply / the fact
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  constraint gf_training_kind check (kind in ('rule','avoid','example','fact','style'))
);

create index if not exists gf_training_target_idx on public.gf_training (target, active);

alter table public.gf_training enable row level security;
drop policy if exists "training admin all" on public.gf_training;
create policy "training admin all" on public.gf_training
  for all using ( public.gf_is_admin() ) with check ( public.gf_is_admin() );



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
    'behaviour', coalesce(c.behaviour, '{}'::jsonb),
    'training', coalesce((
      select json_agg(json_build_object(
               'id', t.id, 'target', t.target, 'kind', t.kind,
               'prompt', t.prompt, 'body', t.body, 'at', t.created_at)
             order by t.created_at)
      from (select * from public.gf_training where active
            order by created_at desc limit 400) t
    ), '[]'::json),
    'updated_at', c.updated_at
  );
end $$;

revoke all on table public.gf_training from anon;
grant select, insert, update, delete on table public.gf_training to authenticated;

notify pgrst, 'reload schema';

-- check: should return one row, with a "training" array and a "behaviour" object
-- select public.gf_get_config();
