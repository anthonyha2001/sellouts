-- 052 — Break time and length per person, everyone but the cashiers (owner, 2026-10-04).
--   staff.break_start ('13:00') and staff.break_minutes (30): the same every working day.
--   staff_set_break(staff, start, minutes): for schedule.manage / schedule.edit (the schedule page).
--   schedule_staff(): also returns them.
-- ADDITIVE (new columns and function; schedule_staff recreated with two more columns).

alter table public.staff add column if not exists break_start text;
alter table public.staff add column if not exists break_minutes integer;
alter table public.staff drop constraint if exists staff_break_check;
alter table public.staff add constraint staff_break_check check (
  (break_start is null or break_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') and (break_minutes is null or break_minutes between 5 and 240));

create or replace function public.staff_set_break(p_staff uuid, p_start text, p_minutes integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm('schedule.manage', 'schedule.edit', 'staff.manage') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  update public.staff set break_start = nullif(p_start, ''), break_minutes = p_minutes, updated_at = now() where id = p_staff;
  if not found then raise exception 'Not found'; end if;
end $$;
revoke execute on function public.staff_set_break(uuid, text, integer) from public, anon;
grant execute on function public.staff_set_break(uuid, text, integer) to authenticated;

drop function if exists public.schedule_staff();
create function public.schedule_staff()
returns table (key text, staff_id uuid, cashier_id uuid, name text, job text, active boolean, sort_order integer,
               pos text, default_station text, has_pin boolean, fixed_days jsonb, break_start text, break_minutes integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_perm('schedule.manage', 'schedule.edit') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
    select coalesce(s.cashier_id, s.id)::text, s.id, s.cashier_id, s.name, s.job, s.active,
           case when c.position in ('cashier', 'supervisor') then c.sort_order else 100000 + s.sort_order end,
           c.position, c.default_station, coalesce(c.has_pin, false), s.fixed_days, s.break_start, s.break_minutes
      from public.staff s left join public.cashiers c on c.id = s.cashier_id
     order by 7, s.name;
end $$;
revoke execute on function public.schedule_staff() from public, anon;
grant execute on function public.schedule_staff() to authenticated;
