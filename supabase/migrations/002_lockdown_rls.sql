-- 002 — Lock the database down to the permissions in PLAN §3 / §10c.
-- Run ONLY after: 001 is applied, the login-enabled app is live, the first admin can sign in,
-- and 014 (per-user permissions: has_perm) is applied.
-- From this moment the old anonymous pages stop working (that is the point).
-- The previous policies were saved by 001 in public._policy_backup_20260929.
-- No data is changed; only policies, privileges and two guard triggers.

-- ---------------------------------------------------------------------------
-- 1. Remove every existing policy on the app tables (the "allow everything" ones).
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('sellouts','credit_notes','catalog_items','app_settings','promotions','promotion_rows',
                        'vendors','vendor_orders','vendor_skips','vendor_rentals',
                        'dt_drivers','dt_customers','dt_orders','dt_settings')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Privileges: anon gets nothing; signed-in users keep plain CRUD (RLS decides the rows).
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
-- Tables created later (next phases) start closed to anon as well.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;

-- RLS on (it already is on all of these; kept so the file is self-contained).
alter table public.sellouts        enable row level security;
alter table public.credit_notes    enable row level security;
alter table public.catalog_items   enable row level security;
alter table public.app_settings    enable row level security;
alter table public.promotions      enable row level security;
alter table public.promotion_rows  enable row level security;
alter table public.vendors         enable row level security;
alter table public.vendor_orders   enable row level security;
alter table public.vendor_skips    enable row level security;
alter table public.vendor_rentals  enable row level security;
alter table public.dt_drivers      enable row level security;
alter table public.dt_customers    enable row level security;
alter table public.dt_orders       enable row level security;
alter table public.dt_settings     enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Policies. All are for signed-in users only; has_perm() (014) is false for disabled or
--    profile-less accounts and always true for an admin.
-- ---------------------------------------------------------------------------

-- Sell-outs. Floor check users read the active ones.
create policy sellouts_select on public.sellouts for select to authenticated
  using (public.has_perm('sellouts.view') or (public.has_perm('floorcheck.do', 'floorcheck.manage') and active));
create policy sellouts_insert on public.sellouts for insert to authenticated
  with check (public.has_perm('sellouts.edit'));
create policy sellouts_update on public.sellouts for update to authenticated
  using (public.has_perm('sellouts.view', 'sellouts.edit', 'sellouts.price', 'sellouts.archive'))
  with check (public.has_perm('sellouts.view', 'sellouts.edit', 'sellouts.price', 'sellouts.archive'));
create policy sellouts_delete on public.sellouts for delete to authenticated
  using (public.has_perm('sellouts.delete'));
-- Which columns may change is decided per permission: archive columns need sellouts.archive,
-- pricing columns sellouts.price, the log and "already notified" flags anyone who sees it,
-- everything else sellouts.edit.
drop trigger if exists sellouts_accountant_guard on public.sellouts;
drop function if exists public.sellouts_accountant_guard();
create or replace function public.sellouts_perm_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare n jsonb := to_jsonb(new); o jsonb := to_jsonb(old); k text; need text;
begin
  if auth.uid() is null then return new; end if;
  for k in select jsonb_object_keys(n) loop
    if n -> k is distinct from o -> k then
      need := case
        when k in ('archived', 'archived_at', 'archived_by') then 'sellouts.archive'
        when k in ('priced_items', 'pricing', 'price_column') then 'sellouts.price'
        when k in ('log', 'notified_flags', 'updated_at') then null
        else 'sellouts.edit' end;
      if need is not null and not public.has_perm(need) then
        raise exception 'You are not allowed to change "%" on a sell-out', k using errcode = '42501';
      end if;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists sellouts_perm_guard on public.sellouts;
create trigger sellouts_perm_guard before update on public.sellouts
  for each row execute function public.sellouts_perm_guard();

-- Promotions. promotions.edit changes everything; promotions.archive only archived / auto_archive;
-- promotions.audit only the rows' Type and Note; promotions.delete removes promotions.
create policy promotions_read on public.promotions for select to authenticated
  using (public.has_perm('promotions.view'));
create policy promotions_insert on public.promotions for insert to authenticated
  with check (public.has_perm('promotions.edit', 'promotions.archive'));   -- upsert; the trigger decides
create policy promotions_update on public.promotions for update to authenticated
  using (public.has_perm('promotions.edit', 'promotions.archive'))
  with check (public.has_perm('promotions.edit', 'promotions.archive'));
create policy promotions_delete on public.promotions for delete to authenticated
  using (public.has_perm('promotions.delete'));
create policy promotion_rows_read on public.promotion_rows for select to authenticated
  using (public.has_perm('promotions.view'));
create policy promotion_rows_insert on public.promotion_rows for insert to authenticated
  with check (public.has_perm('promotions.edit', 'promotions.audit'));    -- upsert; the trigger decides
create policy promotion_rows_update on public.promotion_rows for update to authenticated
  using (public.has_perm('promotions.edit', 'promotions.audit'))
  with check (public.has_perm('promotions.edit', 'promotions.audit'));
create policy promotion_rows_delete on public.promotion_rows for delete to authenticated
  using (public.has_perm('promotions.edit'));

-- The app saves with upsert (INSERT ... ON CONFLICT DO UPDATE): BEFORE INSERT fires even for an
-- existing row, so a new row is refused here and an existing one is judged by the UPDATE branch.
create or replace function public.promotions_perm_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.has_perm('promotions.edit') then return new; end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from public.promotions p where p.id = new.id) then return new; end if;
    raise exception 'You are not allowed to create promotions' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'archived' - 'auto_archive') is distinct from (to_jsonb(old) - 'archived' - 'auto_archive') then
    raise exception 'You can only archive or unarchive this promotion' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists promotions_perm_guard on public.promotions;
create trigger promotions_perm_guard before insert or update on public.promotions
  for each row execute function public.promotions_perm_guard();

create or replace function public.promotion_rows_perm_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.has_perm('promotions.edit') then return new; end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from public.promotion_rows r where r.id = new.id) then return new; end if;
    raise exception 'You are not allowed to add promotion rows' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'price_type' - 'note') is distinct from (to_jsonb(old) - 'price_type' - 'note') then
    raise exception 'You can only set the Type and Note of promotion rows' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists promotion_rows_perm_guard on public.promotion_rows;
create trigger promotion_rows_perm_guard before insert or update on public.promotion_rows
  for each row execute function public.promotion_rows_perm_guard();

create policy catalog_items_read on public.catalog_items for select to authenticated
  using (public.has_perm('promotions.view'));
create policy catalog_items_write on public.catalog_items for all to authenticated
  using (public.has_perm('promotions.edit')) with check (public.has_perm('promotions.edit'));
create policy app_settings_read on public.app_settings for select to authenticated
  using (public.has_perm('promotions.view'));
create policy app_settings_write on public.app_settings for all to authenticated
  using (public.has_perm('promotions.edit')) with check (public.has_perm('promotions.edit'));

-- Floor check users: read-only view of the promotions running today and their rows
-- (owner, 2026-09-29: the floor check covers promotions as well as sell-outs).
create or replace function public.promotion_is_current(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.promotions p
                 where p.id = p_id and not p.archived
                   and p.from_date <= public.beirut_today() and public.beirut_today() <= p.to_date)
$$;
revoke execute on function public.promotion_is_current(text) from public, anon;
grant execute on function public.promotion_is_current(text) to authenticated;
create policy promotions_floor_read on public.promotions for select to authenticated
  using (public.has_perm('floorcheck.do', 'floorcheck.manage') and public.promotion_is_current(id));
create policy promotion_rows_floor_read on public.promotion_rows for select to authenticated
  using (public.has_perm('floorcheck.do', 'floorcheck.manage') and public.promotion_is_current(promotion_id));

-- Credit notes, vendors, old rentals list.
create policy credit_notes_read  on public.credit_notes for select to authenticated using (public.has_perm('creditnotes.view'));
create policy credit_notes_write on public.credit_notes for all to authenticated
  using (public.has_perm('creditnotes.edit')) with check (public.has_perm('creditnotes.edit'));
create policy vendors_all        on public.vendors        for all to authenticated using (public.has_perm('vendors.manage')) with check (public.has_perm('vendors.manage'));
create policy vendor_orders_all  on public.vendor_orders  for all to authenticated using (public.has_perm('vendors.manage')) with check (public.has_perm('vendors.manage'));
create policy vendor_skips_all   on public.vendor_skips   for all to authenticated using (public.has_perm('vendors.manage')) with check (public.has_perm('vendors.manage'));
create policy vendor_rentals_read  on public.vendor_rentals for select to authenticated using (public.has_perm('rentals.view'));
create policy vendor_rentals_write on public.vendor_rentals for all to authenticated
  using (public.has_perm('rentals.contracts')) with check (public.has_perm('rentals.contracts'));

-- Delivery: drivers + settings are read by everyone who uses Delivery, written with delivery.manage.
create policy dt_drivers_select on public.dt_drivers for select to authenticated
  using (public.has_perm('delivery.orders', 'delivery.settle', 'delivery.customers', 'delivery.reports', 'delivery.manage'));
create policy dt_drivers_write on public.dt_drivers for all to authenticated
  using (public.has_perm('delivery.manage')) with check (public.has_perm('delivery.manage'));
create policy dt_settings_select on public.dt_settings for select to authenticated
  using (public.has_perm('delivery.orders', 'delivery.settle', 'delivery.customers', 'delivery.reports', 'delivery.manage'));
create policy dt_settings_write on public.dt_settings for all to authenticated
  using (public.has_perm('delivery.manage')) with check (public.has_perm('delivery.manage'));

-- Customers: read and written by order entry and the Customers page (not by driver payments alone).
create policy dt_customers_select on public.dt_customers for select to authenticated
  using (public.has_perm('delivery.orders', 'delivery.customers', 'delivery.reports', 'delivery.manage'));
create policy dt_customers_write on public.dt_customers for all to authenticated
  using (public.has_perm('delivery.customers', 'delivery.orders', 'delivery.manage'))
  with check (public.has_perm('delivery.customers', 'delivery.orders', 'delivery.manage'));

-- Orders. Which rows/columns may change is decided by the dt_orders_guard trigger (014):
--   delivery.orders: create/edit today's orders; delivery.settle: only paid/paid_at on any order.
--   INSERT is allowed for delivery.settle because the app saves with upsert, which checks INSERT
--   policies even for existing rows; the trigger rejects a genuinely new order.
create policy dt_orders_select on public.dt_orders for select to authenticated
  using (public.has_perm('delivery.orders', 'delivery.settle', 'delivery.customers', 'delivery.reports', 'delivery.manage'));
create policy dt_orders_insert on public.dt_orders for insert to authenticated
  with check (public.has_perm('delivery.orders', 'delivery.settle', 'delivery.manage'));
create policy dt_orders_update on public.dt_orders for update to authenticated
  using (public.has_perm('delivery.orders', 'delivery.settle', 'delivery.manage'))
  with check (public.has_perm('delivery.orders', 'delivery.settle', 'delivery.manage'));
create policy dt_orders_delete on public.dt_orders for delete to authenticated
  using (public.has_perm('delivery.manage'));
