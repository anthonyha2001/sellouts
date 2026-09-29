-- 014 — Per-user permissions (PLAN §10c). Roles become templates: each role has default permissions
-- (role_permissions); the admin can add or remove single permissions for one user (user_permissions).
-- Admins always have every permission. public.has_perm() replaces the role checks in the rules.
-- The defaults reproduce exactly what each role could do before, so nothing changes for anyone
-- until the admin edits a user's permissions.
-- Run AFTER 005, 006, 010, 011 and 012 (it rewrites their rules). 002 (not applied yet) now uses has_perm too.
-- ADDITIVE: new tables and functions; existing policies are replaced by equivalent permission-based ones.

-- ---------------------------------------------------------------------------
-- 1. Catalog, role templates, per-user overrides
-- ---------------------------------------------------------------------------
create table if not exists public.permissions (
  key    text primary key,
  grp    text not null,
  label  text not null,
  sort   integer not null
);
create table if not exists public.role_permissions (
  role  text not null,
  perm  text not null references public.permissions(key) on delete cascade,
  primary key (role, perm)
);
create table if not exists public.user_permissions (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  perm        text not null references public.permissions(key) on delete cascade,
  allowed     boolean not null,                 -- true = added for this user, false = removed
  updated_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, perm)
);

-- Same list as js/core/permissions.js (scripts/tests check they match).
insert into public.permissions (key, grp, label, sort) values
  ('sellouts.view',      'Sell-outs',    'See sell-outs, download and export',                   1),
  ('sellouts.edit',      'Sell-outs',    'Add, edit, duplicate, turn on / off',                  2),
  ('sellouts.price',     'Sell-outs',    'Set new prices',                                       3),
  ('sellouts.archive',   'Sell-outs',    'Archive / unarchive',                                  4),
  ('sellouts.delete',    'Sell-outs',    'Delete',                                               5),
  ('creditnotes.view',   'Credit notes', 'See credit notes',                                     6),
  ('creditnotes.edit',   'Credit notes', 'Add, edit, change status, delete',                     7),
  ('promotions.view',    'Promotions',   'See promotions, export, download files',               8),
  ('promotions.edit',    'Promotions',   'Create promotions, edit rows, import, catalog',        9),
  ('promotions.audit',   'Promotions',   'Set Type and Note in Audit',                          10),
  ('promotions.archive', 'Promotions',   'Archive / unarchive',                                 11),
  ('promotions.delete',  'Promotions',   'Delete promotions',                                   12),
  ('vendors.manage',     'Vendors',      'See and manage vendors and orders',                   13),
  ('rentals.view',       'Rentals',      'See the store map and contracts',                     14),
  ('rentals.contracts',  'Rentals',      'Add and change contracts, billing, sales',            15),
  ('rentals.layout',     'Rentals',      'Edit the map layout',                                 16),
  ('delivery.orders',    'Delivery',     'Add and edit today''s orders',                        17),
  ('delivery.settle',    'Delivery',     'Driver payments (mark paid)',                         18),
  ('delivery.customers', 'Delivery',     'Customers',                                           19),
  ('delivery.reports',   'Delivery',     'Reports',                                             20),
  ('delivery.manage',    'Delivery',     'Drivers, settings, edit or delete any order, backup', 21),
  ('cash.view',          'Cash',         'See cash differences and summaries',                  22),
  ('cash.enter',         'Cash',         'Enter and edit differences',                          23),
  ('cash.lock',          'Cash',         'Lock a month',                                        24),
  ('cash.unlock',        'Cash',         'Unlock a month',                                      25),
  ('cash.cashiers',      'Cash',         'Cashiers, PINs and warning levels',                   26),
  ('floorcheck.do',      'Floor check',  'Do the floor check (own checks)',                     27),
  ('floorcheck.manage',  'Floor check',  'All results, repeat problems, resolve, reopen',       28),
  ('labels.scan',        'Labels',       'Scan items for labels',                               29),
  ('labels.print',       'Labels',       'Print labels (export to Excel)',                      30),
  ('activity.view',      'Activity log', 'See the activity log',                                31)
on conflict (key) do update set grp = excluded.grp, label = excluded.label, sort = excluded.sort;

-- Role templates (admin needs none: it always has everything).
insert into public.role_permissions (role, perm) values
  ('accountant', 'sellouts.view'), ('accountant', 'sellouts.archive'), ('accountant', 'promotions.view'),
  ('accountant', 'delivery.settle'),
  ('accountant', 'cash.view'), ('accountant', 'cash.enter'), ('accountant', 'cash.lock'), ('accountant', 'cash.cashiers'),
  ('accountant', 'labels.print'),
  ('delivery', 'delivery.orders'), ('delivery', 'delivery.settle'), ('delivery', 'delivery.customers'),
  ('floor_manager', 'floorcheck.do'),
  ('shelf', 'labels.scan')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. The check
-- ---------------------------------------------------------------------------
-- True when the signed-in, active user has ANY of the given permissions:
-- admin → always; otherwise the user's override if there is one, else the role template.
create or replace function public.has_perm(variadic p_perms text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.active
      and (pr.role = 'admin' or exists (
        select 1 from unnest(p_perms) k
        where coalesce(
          (select up.allowed from public.user_permissions up where up.user_id = pr.id and up.perm = k),
          exists (select 1 from public.role_permissions rp where rp.role = pr.role and rp.perm = k)))))
$$;
revoke execute on function public.has_perm(text[]) from public, anon;
grant execute on function public.has_perm(text[]) to authenticated;

-- The signed-in user's effective permissions (the app loads them at sign-in).
create or replace function public.my_permissions() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p.key order by p.sort), '{}') from public.permissions p where public.has_perm(p.key)
$$;
revoke execute on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_permissions enable row level security;
revoke all on public.permissions, public.role_permissions, public.user_permissions from anon;
revoke insert, update, delete, truncate, references, trigger on public.permissions, public.role_permissions from authenticated;
revoke truncate, references, trigger on public.user_permissions from authenticated;

drop policy if exists permissions_read on public.permissions;
create policy permissions_read on public.permissions for select to authenticated using (true);
drop policy if exists role_permissions_read on public.role_permissions;
create policy role_permissions_read on public.role_permissions for select to authenticated using (true);
-- Users see their own overrides; only an admin sets them.
drop policy if exists user_permissions_read on public.user_permissions;
create policy user_permissions_read on public.user_permissions for select to authenticated
  using (user_id = auth.uid() or public.is_role('admin'));
drop policy if exists user_permissions_admin on public.user_permissions;
create policy user_permissions_admin on public.user_permissions for all to authenticated
  using (public.is_role('admin')) with check (public.is_role('admin'));

-- ---------------------------------------------------------------------------
-- 3. Activity log
-- ---------------------------------------------------------------------------
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select to authenticated
  using (public.has_perm('activity.view'));

-- ---------------------------------------------------------------------------
-- 4. Delivery orders rule (was by role, 001)
--   delivery.manage : anything.
--   delivery.orders : create orders dated today; edit orders dated today (and keep them today).
--   delivery.settle : on any order change only paid / paid_at.
-- ---------------------------------------------------------------------------
create or replace function public.dt_orders_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- upsert on an existing id: BEFORE INSERT fires before the conflict; the UPDATE branch decides.
    if exists (select 1 from public.dt_orders o where o.id = new.id) then
      return new;
    end if;
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    if public.has_perm('delivery.manage') then return new; end if;
    if public.has_perm('delivery.orders') and new.order_date = public.beirut_today() then return new; end if;
    raise exception 'Only orders dated today (%) can be created', public.beirut_today()
      using errcode = '42501';
  end if;

  -- UPDATE
  new.created_by := old.created_by;
  new.updated_by := auth.uid();
  if public.has_perm('delivery.manage') then return new; end if;
  if public.has_perm('delivery.orders') and old.order_date = public.beirut_today()
     and new.order_date = public.beirut_today() then
    return new;
  end if;
  if public.has_perm('delivery.settle')
     and (to_jsonb(new) - 'paid' - 'paid_at' - 'updated_by')
       = (to_jsonb(old) - 'paid' - 'paid_at' - 'updated_by') then
    return new;
  end if;
  raise exception 'Only the paid status can be changed on this order'
    using errcode = '42501';
end $$;

-- ---------------------------------------------------------------------------
-- 5. Cash (005)
-- ---------------------------------------------------------------------------
create or replace function public.cash_months_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then
    if tg_op = 'UPDATE' and old.locked and not new.locked and not public.has_perm('cash.unlock') then
      raise exception 'You are not allowed to unlock a month' using errcode = '42501';
    end if;
    if tg_op = 'DELETE' and old.locked and not public.has_perm('cash.unlock') then
      raise exception 'You are not allowed to unlock a month' using errcode = '42501';
    end if;
    if tg_op in ('INSERT', 'UPDATE') and new.locked and (tg_op = 'INSERT' or not old.locked)
       and not public.has_perm('cash.lock') then
      raise exception 'You are not allowed to lock a month' using errcode = '42501';
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      if new.locked and (tg_op = 'INSERT' or not old.locked) then
        new.locked_by := auth.uid(); new.locked_at := now();
      elsif not new.locked then
        new.locked_by := null; new.locked_at := null;
      end if;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create or replace function public.set_cashier_pin(p_cashier uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.has_perm('cash.cashiers') then
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

drop policy if exists cashiers_staff on public.cashiers;
drop policy if exists cashiers_read on public.cashiers;
drop policy if exists cashiers_write on public.cashiers;
drop policy if exists cashiers_update on public.cashiers;
create policy cashiers_read   on public.cashiers for select to authenticated using (public.has_perm('cash.view', 'cash.cashiers', 'cash.enter'));
create policy cashiers_write  on public.cashiers for insert to authenticated with check (public.has_perm('cash.cashiers'));
create policy cashiers_update on public.cashiers for update to authenticated using (public.has_perm('cash.cashiers')) with check (public.has_perm('cash.cashiers'));

drop policy if exists cash_differences_staff on public.cash_differences;
drop policy if exists cash_differences_read on public.cash_differences;
drop policy if exists cash_differences_write on public.cash_differences;
create policy cash_differences_read  on public.cash_differences for select to authenticated using (public.has_perm('cash.view', 'cash.enter'));
create policy cash_differences_write on public.cash_differences for all to authenticated
  using (public.has_perm('cash.enter')) with check (public.has_perm('cash.enter'));

drop policy if exists cash_months_staff on public.cash_months;
drop policy if exists cash_months_read on public.cash_months;
drop policy if exists cash_months_write on public.cash_months;
create policy cash_months_read  on public.cash_months for select to authenticated using (public.has_perm('cash.view', 'cash.enter', 'cash.lock', 'cash.unlock'));
create policy cash_months_write on public.cash_months for all to authenticated
  using (public.has_perm('cash.lock', 'cash.unlock')) with check (public.has_perm('cash.lock', 'cash.unlock'));

drop policy if exists cash_settings_staff on public.cash_settings;
drop policy if exists cash_settings_read on public.cash_settings;
drop policy if exists cash_settings_write on public.cash_settings;
create policy cash_settings_read  on public.cash_settings for select to authenticated using (public.has_perm('cash.view', 'cash.enter', 'cash.cashiers'));
create policy cash_settings_write on public.cash_settings for update to authenticated
  using (public.has_perm('cash.cashiers')) with check (public.has_perm('cash.cashiers'));

-- ---------------------------------------------------------------------------
-- 6. Floor check (006): floorcheck.do = own checks; floorcheck.manage = everyone's, resolve, reopen
-- ---------------------------------------------------------------------------
create or replace function public.can_use_floor_check(p_check uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.floor_checks c
    where c.id = p_check
      and (public.has_perm('floorcheck.manage') or (public.has_perm('floorcheck.do') and c.started_by = auth.uid()))
  )
$$;

create or replace function public.floor_check_items_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare done timestamptz;
begin
  if auth.uid() is null then return new; end if;
  select completed_at into done from public.floor_checks where id = new.check_id;
  if tg_op = 'UPDATE' then
    if (new.resolved is distinct from old.resolved) then
      if not public.has_perm('floorcheck.manage') then
        raise exception 'You are not allowed to mark a problem resolved' using errcode = '42501';
      end if;
      new.resolved_by := case when new.resolved then auth.uid() end;
      new.resolved_at := case when new.resolved then now() end;
    end if;
    if done is not null and not public.has_perm('floorcheck.manage')
       and (new.status, new.note, new.photo_path) is distinct from (old.status, old.note, old.photo_path) then
      raise exception 'This check is finished and can no longer be changed' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      new.checked_by := case when new.status = 'pending' then null else auth.uid() end;
      new.checked_at := case when new.status = 'pending' then null else now() end;
    end if;
  elsif done is not null and not public.has_perm('floorcheck.manage') then
    raise exception 'This check is finished and can no longer be changed' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.floor_checks_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  new.started_by := old.started_by; new.check_date := old.check_date; new.started_at := old.started_at;
  if old.completed_at is not null and new.completed_at is null and not public.has_perm('floorcheck.manage') then
    raise exception 'You are not allowed to reopen a finished check' using errcode = '42501';
  end if;
  return new;
end $$;

drop policy if exists floor_checks_select on public.floor_checks;
drop policy if exists floor_checks_insert on public.floor_checks;
drop policy if exists floor_checks_update on public.floor_checks;
drop policy if exists floor_checks_delete on public.floor_checks;
create policy floor_checks_select on public.floor_checks for select to authenticated
  using (public.has_perm('floorcheck.manage') or (public.has_perm('floorcheck.do') and started_by = auth.uid()));
create policy floor_checks_insert on public.floor_checks for insert to authenticated
  with check (public.has_perm('floorcheck.do') and started_by = auth.uid());
create policy floor_checks_update on public.floor_checks for update to authenticated
  using (public.has_perm('floorcheck.manage') or (public.has_perm('floorcheck.do') and started_by = auth.uid()))
  with check (public.has_perm('floorcheck.manage') or (public.has_perm('floorcheck.do') and started_by = auth.uid()));
create policy floor_checks_delete on public.floor_checks for delete to authenticated
  using (public.has_perm('floorcheck.manage'));

drop policy if exists floor_items_delete on public.floor_check_items;
create policy floor_items_delete on public.floor_check_items for delete to authenticated
  using (public.has_perm('floorcheck.manage'));

drop policy if exists floor_photos_insert on storage.objects;
create policy floor_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'floor-photos' and public.has_perm('floorcheck.do', 'floorcheck.manage')
              and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists floor_photos_select on storage.objects;
create policy floor_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'floor-photos'
         and (public.has_perm('floorcheck.manage') or (public.has_perm('floorcheck.do') and (storage.foldername(name))[1] = auth.uid()::text)));
drop policy if exists floor_photos_delete on storage.objects;
create policy floor_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'floor-photos'
         and (public.has_perm('floorcheck.manage') or (storage.foldername(name))[1] = auth.uid()::text));

-- ---------------------------------------------------------------------------
-- 7. Labels (010, 011): labels.scan = own lists; labels.print = submitted lists, export
-- ---------------------------------------------------------------------------
create or replace function public.label_list_editable(p_list uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.label_lists l
                 where l.id = p_list and l.created_by = auth.uid() and l.submitted_at is null
                   and public.has_perm('labels.scan'))
$$;
create or replace function public.label_list_visible(p_list uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.label_lists l
                 where l.id = p_list
                   and ((l.created_by = auth.uid() and public.has_perm('labels.scan'))
                        or (l.submitted_at is not null and public.has_perm('labels.print'))))
$$;

create or replace function public.label_lists_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  new.created_by := old.created_by; new.created_at := old.created_at;
  if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
    raise exception 'A submitted list cannot be reopened' using errcode = '42501';
  end if;
  if new.exported_at is distinct from old.exported_at then
    if not public.has_perm('labels.print') then
      raise exception 'You are not allowed to export labels' using errcode = '42501';
    end if;
    if new.submitted_at is null then
      raise exception 'Only submitted lists can be exported' using errcode = '42501';
    end if;
    new.exported_by := case when new.exported_at is null then null else auth.uid() end;
  else
    new.exported_by := old.exported_by;
  end if;
  return new;
end $$;

drop policy if exists label_lists_select on public.label_lists;
create policy label_lists_select on public.label_lists for select to authenticated
  using ((created_by = auth.uid() and public.has_perm('labels.scan'))
         or (submitted_at is not null and public.has_perm('labels.print')));
drop policy if exists label_lists_insert on public.label_lists;
create policy label_lists_insert on public.label_lists for insert to authenticated
  with check (public.has_perm('labels.scan') and created_by = auth.uid() and submitted_at is null and exported_at is null);
drop policy if exists label_lists_update on public.label_lists;
create policy label_lists_update on public.label_lists for update to authenticated
  using ((created_by = auth.uid() and submitted_at is null and public.has_perm('labels.scan'))
         or (submitted_at is not null and public.has_perm('labels.print')))
  with check (created_by = auth.uid() or public.has_perm('labels.print'));

-- ---------------------------------------------------------------------------
-- 8. Store map + rental contracts (012)
--   rentals.view: read · rentals.contracts: contracts · rentals.layout: floors, elements, types, tracing images
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['store_floors','store_map_objects','store_map_config','rental_contracts'] loop
    execute format('drop policy if exists %I on public.%I', t || '_admin_all', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_perm(''rentals.view''))', t || '_read', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.has_perm(%L)) with check (public.has_perm(%L))',
                   t || '_write', t,
                   case when t = 'rental_contracts' then 'rentals.contracts' else 'rentals.layout' end,
                   case when t = 'rental_contracts' then 'rentals.contracts' else 'rentals.layout' end);
  end loop;
end $$;
drop policy if exists store_layout_versions_read on public.store_layout_versions;
drop policy if exists store_layout_versions_insert on public.store_layout_versions;
create policy store_layout_versions_read   on public.store_layout_versions for select to authenticated using (public.has_perm('rentals.view'));
create policy store_layout_versions_insert on public.store_layout_versions for insert to authenticated with check (public.has_perm('rentals.layout'));

drop policy if exists store_maps_admin on storage.objects;
drop policy if exists store_maps_read on storage.objects;
drop policy if exists store_maps_write on storage.objects;
create policy store_maps_read on storage.objects for select to authenticated
  using (bucket_id = 'store-maps' and public.has_perm('rentals.view'));
create policy store_maps_write on storage.objects for all to authenticated
  using (bucket_id = 'store-maps' and public.has_perm('rentals.layout'))
  with check (bucket_id = 'store-maps' and public.has_perm('rentals.layout'));
