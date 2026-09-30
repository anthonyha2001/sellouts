-- 020 — Weekly staff schedule for cashiers and supervisors (owner, 2026-09-30).
-- Shifts: AM 07:30–14:30, PM 14:30–22:00, Full 07:30–22:00, Off. Cashiers work Front or Back.
-- A week has its staffing needs (front / back / supervisors × AM / PM) and the assignments; it can
-- be copied from the week before. Published weeks are shown to each person on the cashier page.
-- New role 'hr' with permission 'schedule.manage' (admin: everything). Supervisors join the cashiers
-- list (position 'supervisor'): they get a PIN for the cashier page but no cash differences.
-- ADDITIVE.

-- 1. HR role + permission
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'accountant', 'delivery', 'floor_manager', 'shelf', 'hr'));
insert into public.permissions (key, grp, label, sort) values ('schedule.manage', 'Staff schedule', 'Make the weekly schedule; staff list and PINs', 35)
on conflict (key) do nothing;
insert into public.role_permissions (role, perm) values ('hr', 'schedule.manage') on conflict do nothing;

-- 2. Staff: the cashiers list gets a position and a usual station
alter table public.cashiers add column if not exists position text not null default 'cashier';
alter table public.cashiers add column if not exists default_station text;
alter table public.cashiers drop constraint if exists cashiers_position_check;
alter table public.cashiers add constraint cashiers_position_check check (position in ('cashier', 'supervisor'));
alter table public.cashiers drop constraint if exists cashiers_station_check;
alter table public.cashiers add constraint cashiers_station_check check (default_station is null or default_station in ('front', 'back'));
grant select (position, default_station) on public.cashiers to authenticated;
grant insert (position, default_station) on public.cashiers to authenticated;
grant update (position, default_station) on public.cashiers to authenticated;

drop policy if exists cashiers_read on public.cashiers;
drop policy if exists cashiers_write on public.cashiers;
drop policy if exists cashiers_update on public.cashiers;
create policy cashiers_read   on public.cashiers for select to authenticated using (public.has_perm('cash.view', 'cash.cashiers', 'cash.enter', 'schedule.manage'));
create policy cashiers_write  on public.cashiers for insert to authenticated with check (public.has_perm('cash.cashiers', 'schedule.manage'));
create policy cashiers_update on public.cashiers for update to authenticated using (public.has_perm('cash.cashiers', 'schedule.manage')) with check (public.has_perm('cash.cashiers', 'schedule.manage'));

create or replace function public.set_cashier_pin(p_cashier uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.has_perm('cash.cashiers', 'schedule.manage') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_pin is not null and p_pin !~ '^\d{4}$' then
    raise exception 'The PIN must be exactly 4 digits';
  end if;
  update public.cashiers
     set pin_hash = case when p_pin is null then null else crypt(p_pin, gen_salt('bf', 8)) end,
         failed_attempts = 0, locked_until = null
   where id = p_cashier;
  if not found then raise exception 'Cashier not found'; end if;
end $$;

-- 3. Weeks
create table if not exists public.schedule_weeks (
  week_start   date primary key check (extract(isodow from week_start) = 1),   -- Monday
  needs        jsonb not null default '{}',     -- {"front":{"am":2,"pm":2},"back":{"am":1,"pm":1},"supervisor":{"am":1,"pm":1}}
  assignments  jsonb not null default '{}',     -- {"<staff id>": ["am:front","pm:back","off","full:front",…7 days Mon→Sun]}
  published    boolean not null default false,
  note         text,
  updated_by   uuid default auth.uid(),
  updated_at   timestamptz not null default now()
);
create or replace function public.schedule_weeks_stamp() returns trigger
language plpgsql as $$ begin new.updated_by := coalesce(auth.uid(), new.updated_by); new.updated_at := now(); return new; end $$;
drop trigger if exists schedule_weeks_stamp on public.schedule_weeks;
create trigger schedule_weeks_stamp before insert or update on public.schedule_weeks
  for each row execute function public.schedule_weeks_stamp();

alter table public.schedule_weeks enable row level security;
revoke all on public.schedule_weeks from anon;
revoke truncate, references, trigger on public.schedule_weeks from authenticated;
drop policy if exists schedule_weeks_all on public.schedule_weeks;
create policy schedule_weeks_all on public.schedule_weeks for all to authenticated
  using (public.has_perm('schedule.manage')) with check (public.has_perm('schedule.manage'));
