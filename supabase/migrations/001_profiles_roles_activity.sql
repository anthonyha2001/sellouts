-- 001 — Profiles, roles, helper functions, activity log, dt_orders audit columns + edit rule.
-- ADDITIVE ONLY. Does not change any existing policy or grant, so both current apps keep working
-- exactly as before. The lockdown (drop the open policies, role policies, revoke anon) is 002,
-- run only once the login-enabled frontend is live and the first admin exists.

-- ---------------------------------------------------------------------------
-- 0. Record the current policies before anything touches them (002 replaces them).
-- ---------------------------------------------------------------------------
create table if not exists public._policy_backup_20260929 as
  select now() as saved_at, schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  from pg_policies where schemaname = 'public';
alter table public._policy_backup_20260929 enable row level security;   -- no policies = API cannot see it
revoke all on public._policy_backup_20260929 from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Profiles (one per login). Written only by the admin-users edge function (service role).
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  username     text unique not null check (username ~ '^[a-z0-9._-]{2,32}$'),
  display_name text,
  role         text not null check (role in ('admin','accountant','delivery','floor_manager')),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
revoke insert, update, delete, truncate, references, trigger on public.profiles from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------
-- Current user's role; null when signed out, unknown, or inactive.
create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.active
$$;

create or replace function public.is_role(variadic roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() = any(roles), false)
$$;

create or replace function public.beirut_today() returns date
language sql stable as $$
  select (now() at time zone 'Asia/Beirut')::date
$$;

-- Functions are executable by PUBLIC by default; limit them to signed-in users.
revoke execute on function public.app_role() from public, anon;
revoke execute on function public.is_role(text[]) from public, anon;
grant execute on function public.app_role() to authenticated;
grant execute on function public.is_role(text[]) to authenticated;

-- Profiles: everyone reads their own row (the app needs its role); admin reads all.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_role('admin'));

-- ---------------------------------------------------------------------------
-- 3. Activity log — append-only.
-- ---------------------------------------------------------------------------
create table if not exists public.activity_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  username    text,
  role        text,
  module      text not null,
  action      text not null,
  entity_type text,
  entity_id   text,
  summary     text,
  details     jsonb
);
create index if not exists activity_log_at_idx on public.activity_log (at desc);
create index if not exists activity_log_entity_idx on public.activity_log (entity_type, entity_id);
alter table public.activity_log enable row level security;
revoke all on public.activity_log from anon;
revoke update, delete, truncate, references, trigger on public.activity_log from authenticated;

-- Who/when are stamped by the server, so a client cannot log as someone else.
create or replace function public.activity_log_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.at := now();
  new.user_id := auth.uid();
  select p.username, p.role into new.username, new.role from public.profiles p where p.id = auth.uid();
  return new;
end $$;
drop trigger if exists activity_log_stamp on public.activity_log;
create trigger activity_log_stamp before insert on public.activity_log
  for each row execute function public.activity_log_stamp();

drop policy if exists activity_log_insert on public.activity_log;
create policy activity_log_insert on public.activity_log for insert to authenticated
  with check (public.app_role() is not null);
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select to authenticated
  using (public.is_role('admin'));
-- No update/delete policies: nobody can change or remove log rows through the API.

-- ---------------------------------------------------------------------------
-- 4. dt_orders: who created / last changed it, Beirut default date, editing rule.
-- ---------------------------------------------------------------------------
alter table public.dt_orders add column if not exists created_by uuid references auth.users on delete set null;
alter table public.dt_orders add column if not exists updated_by uuid references auth.users on delete set null;
alter table public.dt_orders alter column order_date set default public.beirut_today();  -- was CURRENT_DATE (UTC)

-- Rule (PLAN §3):
--   admin          : anything.
--   delivery       : create orders dated today; edit orders dated today (and keep them today);
--                    on any other order change only paid / paid_at.
--   accountant     : only paid / paid_at (driver payments), on any order.
--   no auth.uid()  : the current anonymous apps and the service role (backups/restores) — unchanged
--                    behaviour until 002 removes anon access.
create or replace function public.dt_orders_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r text := public.app_role();
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- The delivery sync() saves with upsert. For an existing id, BEFORE INSERT fires before the
    -- conflict is detected; let it through, and the UPDATE branch below then applies the real rule.
    if exists (select 1 from public.dt_orders o where o.id = new.id) then
      return new;
    end if;
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    if r = 'admin' then return new; end if;
    if r = 'delivery' and new.order_date = public.beirut_today() then return new; end if;
    raise exception 'Only orders dated today (%) can be created', public.beirut_today()
      using errcode = '42501';
  end if;

  -- UPDATE
  new.created_by := old.created_by;
  new.updated_by := auth.uid();
  if r = 'admin' then return new; end if;
  if r = 'delivery' and old.order_date = public.beirut_today()
     and new.order_date = public.beirut_today() then
    return new;
  end if;
  if r in ('delivery','accountant')
     and (to_jsonb(new) - 'paid' - 'paid_at' - 'updated_by')
       = (to_jsonb(old) - 'paid' - 'paid_at' - 'updated_by') then
    return new;
  end if;
  raise exception 'Only the paid status can be changed on this order'
    using errcode = '42501';
end $$;

drop trigger if exists dt_orders_guard on public.dt_orders;
create trigger dt_orders_guard before insert or update on public.dt_orders
  for each row execute function public.dt_orders_guard();
