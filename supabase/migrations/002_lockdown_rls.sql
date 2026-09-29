-- 002 — Lock the database down to the roles in PLAN §3.
-- Run ONLY after: 001 is applied, the login-enabled app is live, and the first admin can sign in.
-- From this moment the old anonymous pages stop working (that is the point).
-- The previous policies were saved by 001 in public._policy_backup_20260929.
-- No data is changed; only policies and privileges.

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
-- 3. Policies (PLAN §3). All are for signed-in users only; is_role() is false for
--    disabled or profile-less accounts.
-- ---------------------------------------------------------------------------

-- Sell-outs: admin + accountant full; floor manager reads active ones (floor check).
create policy sellouts_select on public.sellouts for select to authenticated
  using (public.is_role('admin','accountant') or (public.is_role('floor_manager') and active));
create policy sellouts_insert on public.sellouts for insert to authenticated
  with check (public.is_role('admin','accountant'));
create policy sellouts_update on public.sellouts for update to authenticated
  using (public.is_role('admin','accountant')) with check (public.is_role('admin','accountant'));
create policy sellouts_delete on public.sellouts for delete to authenticated
  using (public.is_role('admin','accountant'));

-- Promotions and their catalog/settings: admin + accountant.
create policy promotions_all on public.promotions for all to authenticated
  using (public.is_role('admin','accountant')) with check (public.is_role('admin','accountant'));
create policy promotion_rows_all on public.promotion_rows for all to authenticated
  using (public.is_role('admin','accountant')) with check (public.is_role('admin','accountant'));
create policy catalog_items_all on public.catalog_items for all to authenticated
  using (public.is_role('admin','accountant')) with check (public.is_role('admin','accountant'));
create policy app_settings_all on public.app_settings for all to authenticated
  using (public.is_role('admin','accountant')) with check (public.is_role('admin','accountant'));

-- Admin only: credit notes, vendors, vendor orders/skips, rentals.
create policy credit_notes_admin   on public.credit_notes   for all to authenticated using (public.is_role('admin')) with check (public.is_role('admin'));
create policy vendors_admin        on public.vendors        for all to authenticated using (public.is_role('admin')) with check (public.is_role('admin'));
create policy vendor_orders_admin  on public.vendor_orders  for all to authenticated using (public.is_role('admin')) with check (public.is_role('admin'));
create policy vendor_skips_admin   on public.vendor_skips   for all to authenticated using (public.is_role('admin')) with check (public.is_role('admin'));
create policy vendor_rentals_admin on public.vendor_rentals for all to authenticated using (public.is_role('admin')) with check (public.is_role('admin'));

-- Delivery: drivers + settings are read by everyone who uses Delivery, written by admin.
create policy dt_drivers_select on public.dt_drivers for select to authenticated
  using (public.is_role('admin','delivery','accountant'));
create policy dt_drivers_write on public.dt_drivers for all to authenticated
  using (public.is_role('admin')) with check (public.is_role('admin'));
create policy dt_settings_select on public.dt_settings for select to authenticated
  using (public.is_role('admin','delivery','accountant'));
create policy dt_settings_write on public.dt_settings for all to authenticated
  using (public.is_role('admin')) with check (public.is_role('admin'));

-- Customers: admin + delivery.
create policy dt_customers_all on public.dt_customers for all to authenticated
  using (public.is_role('admin','delivery')) with check (public.is_role('admin','delivery'));

-- Orders. Which rows/columns may change is decided by the dt_orders_guard trigger (001):
--   delivery: create/edit today's orders, only paid/paid_at on older ones;
--   accountant: only paid/paid_at. INSERT is allowed for the accountant because the app saves
--   with upsert (INSERT ... ON CONFLICT DO UPDATE), which checks INSERT policies even for
--   existing rows; the trigger rejects a genuinely new order from an accountant.
create policy dt_orders_select on public.dt_orders for select to authenticated
  using (public.is_role('admin','delivery','accountant'));
create policy dt_orders_insert on public.dt_orders for insert to authenticated
  with check (public.is_role('admin','delivery','accountant'));
create policy dt_orders_update on public.dt_orders for update to authenticated
  using (public.is_role('admin','delivery','accountant')) with check (public.is_role('admin','delivery','accountant'));
create policy dt_orders_delete on public.dt_orders for delete to authenticated
  using (public.is_role('admin'));
