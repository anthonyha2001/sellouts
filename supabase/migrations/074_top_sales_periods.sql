-- 074 — Top sales per day / week / month, and the items to pay attention to (owner, 2026-10-11).
--   period    : 'day' (yesterday vs the daily average of the 4 weeks before), 'week' (last 7 days vs the weekly average
--               of the 8 weeks before), 'month' (last 30 days vs the monthly average of the 3 months before).
--   per_day   : the selling rate used for the days of stock left.
--   attention : out of stock, or fewer days of stock than the vendor needs to be re-supplied.
-- Run after 073. The table only holds daily recounts (14 days kept), so the old rows are simply replaced.
-- The store has ~150k items: one cron job per period, a few minutes apart (one period per call fits the function's time).

truncate public.top_sales;
alter table public.top_sales add column if not exists period text not null default 'week';
alter table public.top_sales add column if not exists per_day numeric;
alter table public.top_sales add column if not exists attention boolean not null default false;
alter table public.top_sales drop constraint if exists top_sales_pkey;
alter table public.top_sales add primary key (week_end, period, code);

do $$
declare j text;
begin
  foreach j in array array['top-sales', 'top-sales-day', 'top-sales-week', 'top-sales-month'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;

-- every day, 05:00 / 05:05 / 05:10 UTC = 08:00 Beirut (07:00 in winter)
select cron.schedule('top-sales-day', '0 5 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"top_sales","period":"day"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
select cron.schedule('top-sales-week', '5 5 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"top_sales","period":"week"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
select cron.schedule('top-sales-month', '10 5 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"top_sales","period":"month"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
