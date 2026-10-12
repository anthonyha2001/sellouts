-- 084 — Expiries (owner, 2026-10-12): the items on the shelves that expire soon, month by month.
--   The floor manager enters them (scan, month, quantity, shelf) and gives each one to a shelf worker; the shelf
--   worker sees the ones given to them and marks what was done (removed, put on discount, returned, sold).
--   Who: expiry.manage (floor manager by default): sees and changes everything; expiry.work (shelf worker by
--   default): sees only what was given to them and can only mark it done / not done.
--   Shelf workers come from Staff (job "Shelf worker"; their app login, when they have one, sees their list), and
--   from the app users with the Shelf worker role who are not in Staff.
-- ADDITIVE (new table, two permissions, functions, trigger, realtime).

insert into public.permissions (key, grp, label, sort) values
  ('expiry.manage', 'Expiries', 'Enter expiries, give them to shelf workers, see them all', 40),
  ('expiry.work',   'Expiries', 'See the expiries given to me and mark them done',          41)
on conflict (key) do update set grp = excluded.grp, label = excluded.label, sort = excluded.sort;
insert into public.role_permissions (role, perm) values
  ('floor_manager', 'expiry.manage'), ('shelf', 'expiry.work')
on conflict do nothing;

create table if not exists public.expiries (
  id               uuid primary key default gen_random_uuid(),
  code             text not null check (length(trim(code)) > 0),
  description      text,
  barcode          text,
  supplier         text,
  item_group       text,
  expiry_date      date not null,          -- the day on the pack; the month's last day when only the month is known
  day_known        boolean not null default true,
  qty              numeric,
  location         text,                   -- shelf / aisle
  note             text,
  assigned_staff   uuid references public.staff(id) on delete set null,
  assigned_user    uuid references public.profiles(id) on delete set null,
  assigned_name    text,
  assigned_at      timestamptz,
  status           text not null default 'open' check (status in ('open', 'done')),
  outcome          text check (outcome is null or outcome in ('removed', 'discount', 'returned', 'sold', 'other')),
  done_note        text,
  done_at          timestamptz,
  done_by          uuid,
  done_by_name     text,
  created_by       uuid default auth.uid(),
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists expiries_date_idx on public.expiries (expiry_date);
create index if not exists expiries_user_idx on public.expiries (assigned_user) where status = 'open';

-- The shelf workers the floor manager can give expiries to (Staff is private to staff.manage, so through here).
create or replace function public.expiry_workers()
returns table (staff_id uuid, user_id uuid, name text, sections text)
language sql stable security definer set search_path = public as $$
  select s.id, s.user_id, s.name, s.sections
    from public.staff s
   where s.active and lower(trim(s.job)) = 'shelf worker' and public.has_perm('expiry.manage')
  union all
  select null::uuid, p.id, coalesce(nullif(trim(p.display_name), ''), p.username), null::text
    from public.profiles p
   where p.active and p.role = 'shelf' and public.has_perm('expiry.manage')
     and not exists (select 1 from public.staff s where s.user_id = p.id)
  order by 3
$$;
revoke execute on function public.expiry_workers() from public, anon;
grant execute on function public.expiry_workers() to authenticated;

-- Stamps who / when, fills the shelf worker's name and login, and keeps a shelf worker to marking done.
create or replace function public.expiries_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare me text; mgr boolean;
begin
  new.updated_at := now();
  if auth.uid() is null then return new; end if;     -- service role / maintenance
  select coalesce(nullif(trim(display_name), ''), username) into me from public.profiles where id = auth.uid();
  mgr := public.has_perm('expiry.manage');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_by_name := me; new.created_at := now();
  elsif not mgr then
    if (new.code, new.description, new.barcode, new.supplier, new.item_group, new.expiry_date, new.day_known, new.qty, new.location, new.note,
        new.assigned_staff, new.assigned_user, new.created_by, new.created_at)
       is distinct from
       (old.code, old.description, old.barcode, old.supplier, old.item_group, old.expiry_date, old.day_known, old.qty, old.location, old.note,
        old.assigned_staff, old.assigned_user, old.created_by, old.created_at) then
      raise exception 'Only the floor manager can change this expiry' using errcode = '42501';
    end if;
  end if;
  -- the shelf worker: from Staff (and their login), or an app user with the Shelf worker role
  if tg_op = 'INSERT' or new.assigned_staff is distinct from old.assigned_staff or new.assigned_user is distinct from old.assigned_user then
    if new.assigned_staff is not null then
      select s.name, s.user_id into new.assigned_name, new.assigned_user from public.staff s where s.id = new.assigned_staff;
    elsif new.assigned_user is not null then
      select coalesce(nullif(trim(p.display_name), ''), p.username) into new.assigned_name from public.profiles p where p.id = new.assigned_user;
    else
      new.assigned_name := null;
    end if;
    new.assigned_at := case when new.assigned_staff is null and new.assigned_user is null then null else now() end;
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status = 'done' then
      new.done_at := now(); new.done_by := auth.uid(); new.done_by_name := me;
    else
      new.done_at := null; new.done_by := null; new.done_by_name := null; new.outcome := null; new.done_note := null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists expiries_guard on public.expiries;
create trigger expiries_guard before insert or update on public.expiries
  for each row execute function public.expiries_guard();

alter table public.expiries enable row level security;
revoke all on public.expiries from anon;
grant select, insert, update, delete on public.expiries to authenticated;
drop policy if exists expiries_read on public.expiries;
create policy expiries_read on public.expiries for select to authenticated
  using (public.has_perm('expiry.manage') or (public.has_perm('expiry.work') and assigned_user = auth.uid()));
drop policy if exists expiries_insert on public.expiries;
create policy expiries_insert on public.expiries for insert to authenticated
  with check (public.has_perm('expiry.manage'));
drop policy if exists expiries_update on public.expiries;
create policy expiries_update on public.expiries for update to authenticated
  using (public.has_perm('expiry.manage') or (public.has_perm('expiry.work') and assigned_user = auth.uid()))
  with check (public.has_perm('expiry.manage') or (public.has_perm('expiry.work') and assigned_user = auth.uid()));
drop policy if exists expiries_delete on public.expiries;
create policy expiries_delete on public.expiries for delete to authenticated
  using (public.has_perm('expiry.manage'));

-- Live updates on the Expiries page (migration 021).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'expiries') then
    alter publication supabase_realtime add table public.expiries;
  end if;
end $$;
