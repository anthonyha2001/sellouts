-- 050 — Fixed schedules for the departments that are not published (owner, 2026-10-04).
-- Cashiers and the delivery team keep their weekly, published schedule. Everyone else (floor & shelves,
-- warehouse, counters, bakery, office) works a FIXED week: the same days and shifts every week, edited any
-- time, with their department's own shift times.
--   staff.fixed_days: ['am', 'pm|05:00-12:00', 'off', '', …] Monday -> Sunday (same codes as the weeks).
--   schedule_dept_shifts: a department's shift times, {"am":["05:00","12:00"],"pm":[…],"full":[…]}.
--   staff_set_fixed(staff, days): for schedule.manage / schedule.edit (they cannot write the staff table).
--   schedule_staff(): also returns fixed_days.
-- ADDITIVE (new column, table and function; schedule_staff recreated with one more column).

alter table public.staff add column if not exists fixed_days jsonb;

create table if not exists public.schedule_dept_shifts (
  dept       text primary key,
  shifts     jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.schedule_dept_shifts enable row level security;
revoke all on public.schedule_dept_shifts from anon;
grant select, insert, update on public.schedule_dept_shifts to authenticated;
drop policy if exists dept_shifts_read on public.schedule_dept_shifts;
create policy dept_shifts_read on public.schedule_dept_shifts for select to authenticated
  using (public.has_perm('schedule.manage', 'schedule.edit'));
drop policy if exists dept_shifts_write on public.schedule_dept_shifts;
create policy dept_shifts_write on public.schedule_dept_shifts for all to authenticated
  using (public.has_perm('schedule.manage', 'schedule.edit')) with check (public.has_perm('schedule.manage', 'schedule.edit'));

create or replace function public.staff_set_fixed(p_staff uuid, p_days jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm('schedule.manage', 'schedule.edit') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_days is not null and (jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) > 7) then
    raise exception 'Bad schedule';
  end if;
  update public.staff set fixed_days = p_days, updated_at = now() where id = p_staff;
  if not found then raise exception 'Not found'; end if;
end $$;
revoke execute on function public.staff_set_fixed(uuid, jsonb) from public, anon;
grant execute on function public.staff_set_fixed(uuid, jsonb) to authenticated;

drop function if exists public.schedule_staff();
create function public.schedule_staff()
returns table (key text, staff_id uuid, cashier_id uuid, name text, job text, active boolean, sort_order integer,
               pos text, default_station text, has_pin boolean, fixed_days jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_perm('schedule.manage', 'schedule.edit') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
    select coalesce(s.cashier_id, s.id)::text, s.id, s.cashier_id, s.name, s.job, s.active,
           case when c.position in ('cashier', 'supervisor') then c.sort_order else 100000 + s.sort_order end,
           c.position, c.default_station, coalesce(c.has_pin, false), s.fixed_days
      from public.staff s left join public.cashiers c on c.id = s.cashier_id
     order by 7, s.name;
end $$;
revoke execute on function public.schedule_staff() from public, anon;
grant execute on function public.schedule_staff() to authenticated;
