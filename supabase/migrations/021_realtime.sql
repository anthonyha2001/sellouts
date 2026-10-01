-- 021 — Live updates (owner, 2026-10-01): changes made by someone else show up on open pages
-- without a reload. Adds the app's tables to Supabase Realtime (the delivery tables are in already).
-- Realtime checks each listener's RLS before sending a change, so people are only told about rows
-- they may read. Not added: cashiers (it holds the PIN hash), push_*, permissions tables, settings.
-- ADDITIVE. Running it twice is harmless.

do $$
declare t text;
begin
  foreach t in array array[
    'sellouts', 'credit_notes',
    'promotions', 'promotion_rows', 'catalog_items',
    'vendors', 'vendor_orders', 'vendor_skips',
    'rental_contracts', 'rental_supplier_sales',
    'cash_differences', 'cash_months', 'cash_settings',
    'floor_checks', 'floor_check_items', 'spot_checks',
    'label_lists', 'label_items',
    'promo_ladies', 'promo_lady_attendance',
    'schedule_weeks',
    'profiles', 'user_permissions',
    'activity_log'
  ] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
