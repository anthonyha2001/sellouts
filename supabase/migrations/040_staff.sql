-- 040 — Staff: one list of every employee (owner, 2026-10-03).
-- Each person: name, job, and optional phone, start date, salary, note; active or left; and the app login
-- they were given (profiles). Cashiers and supervisors are ALSO in the cashiers list (cash differences,
-- schedule, cashier page, PINs) — kept in step both ways by the triggers below, so nothing else changes:
--   * a staff member whose job is Cashier / Supervisor has a cashiers row (created when needed);
--     their name, active and position follow the staff row; another job switches that row off;
--   * a cashier added or changed on the Cash / Staff schedule pages updates (or creates) their staff row.
-- Who sees the page (and salaries): permission staff.manage (admin; tick it for HR in Users if wanted).
-- ADDITIVE (new table, permission, functions and triggers; existing cashiers copied in).

insert into public.permissions (key, grp, label, sort)
values ('staff.manage', 'Staff', 'Staff list: every employee, job, phone, salary; create their app login', 37)
on conflict (key) do nothing;

create table if not exists public.staff (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  job         text not null default 'Cashier',
  phone       text,
  start_date  date,
  salary      numeric,
  note        text,
  active      boolean not null default true,
  cashier_id  uuid unique references public.cashiers(id) on delete set null,
  user_id     uuid unique references public.profiles(id) on delete set null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.staff enable row level security;
revoke all on public.staff from anon;
grant select, insert, update, delete on public.staff to authenticated;
drop policy if exists staff_all on public.staff;
create policy staff_all on public.staff for all to authenticated
  using (public.has_perm('staff.manage')) with check (public.has_perm('staff.manage'));

-- Cashier / Supervisor jobs (any case) are the ones that live in the cashiers list too.
create or replace function public.staff_position(p_job text) returns text
language sql immutable as $$
  select case lower(trim(coalesce(p_job, ''))) when 'cashier' then 'cashier' when 'supervisor' then 'supervisor' else null end
$$;

-- staff -> cashiers
create or replace function public.staff_sync_cashier() returns trigger
language plpgsql security definer set search_path = public as $$
declare pos text := public.staff_position(new.job); cid uuid;
begin
  if pg_trigger_depth() > 1 then return new; end if;     -- called from cashiers_sync_staff
  new.updated_at := now();
  if pos is not null then
    if new.cashier_id is null then
      select id into cid from public.cashiers where lower(trim(name)) = lower(trim(new.name)) limit 1;
      if cid is null then
        insert into public.cashiers (name, active, position, sort_order)
        values (trim(new.name), new.active, pos, coalesce((select max(sort_order) + 1 from public.cashiers), 0))
        returning id into cid;
      end if;
      new.cashier_id := cid;
    end if;
    update public.cashiers set name = trim(new.name), active = new.active, position = pos
     where id = new.cashier_id and (name, active, position) is distinct from (trim(new.name), new.active, pos);
  elsif new.cashier_id is not null then
    update public.cashiers set active = false where id = new.cashier_id and active;   -- not a cashier any more
  end if;
  return new;
end $$;
drop trigger if exists staff_sync_cashier on public.staff;
create trigger staff_sync_cashier before insert or update on public.staff
  for each row execute function public.staff_sync_cashier();

-- cashiers -> staff
create or replace function public.cashiers_sync_staff() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;     -- called from staff_sync_cashier
  if exists (select 1 from public.staff where cashier_id = new.id) then
    -- switched back on as a cashier: their job is Cashier / Supervisor again
    update public.staff
       set name = new.name, active = new.active, updated_at = now(),
           job = case when public.staff_position(job) is not null
                        or (new.active and (tg_op = 'INSERT' or not old.active)) then initcap(new.position) else job end
     where cashier_id = new.id;
  else
    insert into public.staff (name, job, active, cashier_id, sort_order)
    values (new.name, initcap(new.position), new.active, new.id, new.sort_order);
  end if;
  return new;
end $$;
drop trigger if exists cashiers_sync_staff on public.cashiers;
create trigger cashiers_sync_staff after insert or update of name, active, position on public.cashiers
  for each row execute function public.cashiers_sync_staff();

-- Everyone already in the cashiers list becomes a staff member.
insert into public.staff (name, job, active, cashier_id, sort_order)
select c.name, initcap(c.position), c.active, c.id, c.sort_order
  from public.cashiers c
 where not exists (select 1 from public.staff s where s.cashier_id = c.id);

-- Live updates on the Staff page (migration 021).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'staff') then
    alter publication supabase_realtime add table public.staff;
  end if;
end $$;
