-- 066 — Low stock, live, for the suppliers you choose (owner, 2026-10-06).
--   Vendors page: "Watch stock" on a vendor, linked to its supplier(s) in the system. Every 15 minutes from
--   07:00 to 19:00 Beirut, lv-dashboard 'stock_watch' re-checks the watched vendor checked longest ago: its items
--   that SOLD in the last 30 days (inactive items are ignored), their stock now at Ajaltoun. An item is low when
--   its stock covers fewer days than the vendor needs (cover days; default: lead time + 4) at its own daily
--   sales, or is at 0 while selling. stock_alerts keeps them; when an item is back above, it is resolved.
--   push-alerts sends ONE notification per vendor per day, only when something newly ran low.
-- ADDITIVE (vendor columns, one table, its read policy, a cron job).

alter table public.vendors add column if not exists watch_stock boolean not null default false;
alter table public.vendors add column if not exists system_suppliers jsonb not null default '[]';   -- [{ code, name }]
alter table public.vendors add column if not exists cover_days integer;
alter table public.vendors add column if not exists stock_checked_at timestamptz;

create table if not exists public.stock_alerts (
  vendor_id    text not null,
  code         text not null,
  description  text,
  stock        numeric,
  sold30       numeric,
  per_day      numeric,
  days_left    numeric,
  cover_days   numeric,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  resolved_at  timestamptz,
  primary key (vendor_id, code)
);
create index if not exists stock_alerts_open on public.stock_alerts (vendor_id) where resolved_at is null;
alter table public.stock_alerts enable row level security;
drop policy if exists stock_alerts_read on public.stock_alerts;
create policy stock_alerts_read on public.stock_alerts for select to authenticated using (public.has_perm('vendors.manage'));

do $$
begin
  if exists (select 1 from cron.job where jobname = 'stock-watch') then perform cron.unschedule('stock-watch'); end if;
end $$;
-- 04:00 – 15:45 UTC = 07:00 – 18:45 Beirut
select cron.schedule('stock-watch', '*/15 4-15 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"stock_watch"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
