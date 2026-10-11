-- 075 — Stock control: overstock and slow movers (owner, 2026-10-11). Run after 073 / 074.
--   kind 'overstock': bought in the last 90 days, stock covering 12 weeks or more at its selling rate, worth $50+.
--   kind 'slow'     : selling at most half of what it sold before (last 4 weeks vs the 8 weeks before), with stock left.
-- Counted every morning by lv-dashboard (stock_review, one kind per call), 14 days kept; the page shows the latest day.
-- Additive only: a new table and two cron jobs.

create table if not exists public.stock_review (
  day date not null,                 -- the day counted (yesterday of the run)
  kind text not null,                -- 'overstock' | 'slow'
  code text not null,
  vendor_id text,
  supplier text,
  description text,
  stock numeric,                     -- in the system now (null: not read)
  per_week numeric,                  -- selling rate: overstock = the last 90 days / 12.9; slow = the last 4 weeks / 4
  prior_week numeric,                -- slow: the 8 weeks before / 8
  weeks_cover numeric,               -- stock / per_week (null: no sales)
  bought numeric,                    -- overstock: units bought in the last 90 days
  sold numeric,                      -- overstock: units sold in the last 90 days
  unit_cost numeric,                 -- the last 90 days' purchases / their units
  value numeric,                     -- stock x unit cost
  created_at timestamptz not null default now(),
  primary key (day, kind, code)
);
alter table public.stock_review enable row level security;
drop policy if exists stock_review_read on public.stock_review;
create policy stock_review_read on public.stock_review for select to authenticated using (public.has_perm('vendors.manage'));

do $$
declare j text;
begin
  foreach j in array array['stock-review-overstock', 'stock-review-slow'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;

-- every day 05:20 / 05:30 UTC = 08:20 / 08:30 Beirut (07:20 / 07:30 in winter)
select cron.schedule('stock-review-overstock', '20 5 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"stock_review","kind":"overstock"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
select cron.schedule('stock-review-slow', '30 5 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"stock_review","kind":"slow"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
