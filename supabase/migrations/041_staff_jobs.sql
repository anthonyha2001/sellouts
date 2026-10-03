-- 041 — The store's own job list, and the sections a shelf worker looks after (owner, 2026-10-03).
--   Jobs: Cashier, Cashier supervisor, Delivery supervisor, Deli counter, Meat counter, Fish counter, Bakery,
--   Picker, Warehouse keeper, Warehouse worker, Shelf worker, Purchasing, Senior accountant, HR, Floor manager.
--   "Cashier supervisor" is the cashiers list's supervisor (was "Supervisor"); "Delivery supervisor" is not.
--   staff.sections: free text, e.g. "Detergents, Pasta, Rice" (shelf workers).
-- ADDITIVE (new column; the two job functions replaced; "Supervisor" renamed "Cashier supervisor").

alter table public.staff add column if not exists sections text;

create or replace function public.staff_position(p_job text) returns text
language sql immutable as $$
  select case lower(trim(coalesce(p_job, '')))
    when 'cashier' then 'cashier'
    when 'cashier supervisor' then 'supervisor'
    when 'supervisor' then 'supervisor'
    else null end
$$;
-- The job name for a cashiers-list position.
create or replace function public.staff_job_of(p_position text) returns text
language sql immutable as $$
  select case p_position when 'supervisor' then 'Cashier supervisor' else 'Cashier' end
$$;

create or replace function public.cashiers_sync_staff() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;     -- called from staff_sync_cashier
  if exists (select 1 from public.staff where cashier_id = new.id) then
    -- switched back on as a cashier: their job is Cashier / Cashier supervisor again
    update public.staff
       set name = new.name, active = new.active, updated_at = now(),
           job = case when public.staff_position(job) is not null
                        or (new.active and (tg_op = 'INSERT' or not old.active)) then public.staff_job_of(new.position) else job end
     where cashier_id = new.id;
  else
    insert into public.staff (name, job, active, cashier_id, sort_order)
    values (new.name, public.staff_job_of(new.position), new.active, new.id, new.sort_order);
  end if;
  return new;
end $$;

update public.staff set job = 'Cashier supervisor' where lower(trim(job)) = 'supervisor';
