-- 045 — PINs on the Staff page; delivery supervisors get one (owner, 2026-10-04).
--   * Delivery supervisors join the cashiers list (position 'delivery_supervisor'), like pickers: a PIN for
--     the cashier page and a column on the Cash page. They are in the schedule's Delivery tab.
--   * The Staff page (staff.manage) sets PINs and the usual station (the schedule's Staff tab is gone).
-- ADDITIVE (position check widened; job functions, set_cashier_pin and the cashiers policies replaced
-- with one more permission).

alter table public.cashiers drop constraint if exists cashiers_position_check;
alter table public.cashiers add constraint cashiers_position_check
  check (position in ('cashier', 'supervisor', 'picker', 'delivery_supervisor'));

create or replace function public.staff_position(p_job text) returns text
language sql immutable as $$
  select case lower(trim(coalesce(p_job, '')))
    when 'cashier' then 'cashier'
    when 'cashier supervisor' then 'supervisor'
    when 'supervisor' then 'supervisor'
    when 'picker' then 'picker'
    when 'delivery supervisor' then 'delivery_supervisor'
    else null end
$$;
create or replace function public.staff_job_of(p_position text) returns text
language sql immutable as $$
  select case p_position when 'supervisor' then 'Cashier supervisor' when 'picker' then 'Picker'
    when 'delivery_supervisor' then 'Delivery supervisor' else 'Cashier' end
$$;

create or replace function public.set_cashier_pin(p_cashier uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.has_perm('cash.cashiers', 'schedule.manage', 'staff.manage') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_pin is not null and p_pin !~ '^\d{4}$' then
    raise exception 'The PIN must be exactly 4 digits';
  end if;
  update public.cashiers
     set pin_hash = case when p_pin is null then null else crypt(p_pin, gen_salt('bf', 8)) end,
         pin = p_pin,
         failed_attempts = 0, locked_until = null
   where id = p_cashier;
  if not found then raise exception 'Cashier not found'; end if;
end $$;

drop policy if exists cashiers_read on public.cashiers;
create policy cashiers_read on public.cashiers for select to authenticated
  using (public.has_perm('cash.view', 'cash.cashiers', 'cash.enter', 'schedule.manage', 'schedule.edit', 'staff.manage'));
drop policy if exists cashiers_update on public.cashiers;
create policy cashiers_update on public.cashiers for update to authenticated
  using (public.has_perm('cash.cashiers', 'schedule.manage', 'staff.manage'))
  with check (public.has_perm('cash.cashiers', 'schedule.manage', 'staff.manage'));

-- Delivery supervisors already on the Staff page get their cashiers row (the staff trigger creates it).
update public.staff set updated_at = now() where lower(trim(job)) = 'delivery supervisor' and cashier_id is null;
