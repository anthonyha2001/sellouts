-- 083 — Ghost stock (owner, 2026-10-11: "the low stock doesn't fight the ghost stock"): the system shows stock but the
--   item, which sells regularly, has not sold for so long that it almost never happens by chance (lv-dashboard stock
--   watch: sold on 6+ days of the last 30, at least 3 units expected in the full days since its last sale, 2 days at
--   least). Most likely the shelf is empty: Stock control › Low stock lists them under "Check the shelf", and
--   push-alerts tells it once a day.
-- Additive only: four columns.

alter table public.stock_alerts add column if not exists ghost boolean not null default false;
alter table public.stock_alerts add column if not exists last_sale date;          -- its last day with a sale (the last 30 days)
alter table public.stock_alerts add column if not exists quiet_days integer;      -- full days without a sale since (today not counted)
alter table public.stock_alerts add column if not exists days_sold integer;       -- days with a sale in the last 30
