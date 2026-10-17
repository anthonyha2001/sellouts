-- 096 — Trainee cashiers (owner, 2026-10-18): a cashier marked "trainee" still shows in the weekly schedule (to place next to a
--   senior), but is not counted in the coverage totals ("how many work each day"). Marked with a checkbox on Staff.
-- Additive only: one column, and schedule_staff() returns it.
alter table public.staff add column if not exists trainee boolean not null default false;

drop function if exists public.schedule_staff();
create or replace function public.schedule_staff()
 returns table(key text, staff_id uuid, cashier_id uuid, name text, job text, active boolean, sort_order integer, pos text, default_station text, has_pin boolean, fixed_days jsonb, break_start text, break_minutes integer, trainee boolean)
 language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not public.has_perm('schedule.manage', 'schedule.edit') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
    select coalesce(s.cashier_id, s.id)::text, s.id, s.cashier_id, s.name, s.job, s.active,
           case when c.position in ('cashier', 'supervisor') then c.sort_order else 100000 + s.sort_order end,
           c.position, c.default_station, coalesce(c.has_pin, false), s.fixed_days, s.break_start, s.break_minutes, coalesce(s.trainee, false)
      from public.staff s left join public.cashiers c on c.id = s.cashier_id
     order by 7, s.name;
end $function$;

revoke execute on function public.schedule_staff() from public, anon;
grant execute on function public.schedule_staff() to authenticated;
