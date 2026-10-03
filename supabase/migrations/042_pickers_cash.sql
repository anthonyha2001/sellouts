-- 042 — Pickers handle cash too (owner, 2026-10-03): the job "Picker" is in the cashiers list as position
-- 'picker' — a column on the Cash page, their differences on the cashier page with a PIN — but not in the
-- staff schedule (the app leaves pickers out there). Cashier supervisors were already on the Cash page.
-- ADDITIVE (position check widened; the two job functions replaced to know Picker).

alter table public.cashiers drop constraint if exists cashiers_position_check;
alter table public.cashiers add constraint cashiers_position_check check (position in ('cashier', 'supervisor', 'picker'));

create or replace function public.staff_position(p_job text) returns text
language sql immutable as $$
  select case lower(trim(coalesce(p_job, '')))
    when 'cashier' then 'cashier'
    when 'cashier supervisor' then 'supervisor'
    when 'supervisor' then 'supervisor'
    when 'picker' then 'picker'
    else null end
$$;
create or replace function public.staff_job_of(p_position text) returns text
language sql immutable as $$
  select case p_position when 'supervisor' then 'Cashier supervisor' when 'picker' then 'Picker' else 'Cashier' end
$$;

-- Pickers already in the staff list get their cashiers row (the staff trigger creates it).
update public.staff set updated_at = now() where lower(trim(job)) = 'picker' and cashier_id is null;
