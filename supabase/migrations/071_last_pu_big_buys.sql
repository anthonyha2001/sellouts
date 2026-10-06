-- 071 — Low stock & orders (owner, 2026-10-06):
--   1. each item running low: its last PU (day, quantity) and the units sold from that day to today
--      (filled by the stock watch, lv-dashboard); last_pu_state: ok | none (no PU in 12 months) | failed (could not be read).
--   2. big purchases: a PU of an item far above its usual order (at least 3 times the usual quantity of its purchase days
--      in the 12 months before, with at least 2 earlier purchases, worth $100 or more). Checked every 30 minutes from 07:00
--      to 19:00 Beirut (lv-dashboard big_buys); push-alerts notifies once per PU.
-- Additive only: new columns, a new table, a new cron job.

alter table public.stock_alerts add column if not exists last_pu_date date;
alter table public.stock_alerts add column if not exists last_pu_qty numeric;
alter table public.stock_alerts add column if not exists sold_since numeric;
alter table public.stock_alerts add column if not exists last_pu_state text;

create table if not exists public.big_purchases (
  day date not null,
  code text not null,
  description text,
  supplier text,
  qty numeric not null,
  value numeric,
  usual_qty numeric,
  times integer,
  weekly_sales numeric,
  weeks_cover numeric,
  documents text,
  buyers text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (day, code)
);
alter table public.big_purchases enable row level security;
drop policy if exists big_purchases_read on public.big_purchases;
create policy big_purchases_read on public.big_purchases for select to authenticated using (public.has_perm('vendors.manage'));

do $$
begin
  if exists (select 1 from cron.job where jobname = 'big-buys') then perform cron.unschedule('big-buys'); end if;
end $$;
-- 04:00 – 15:30 UTC = 07:00 – 18:30 Beirut, every 30 minutes
select cron.schedule('big-buys', '*/30 4-15 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"big_buys"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
