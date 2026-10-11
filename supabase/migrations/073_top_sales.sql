-- 073 — Top sales (owner, 2026-10-11): the items selling more than they used to, per supplier, so they get re-ordered.
--   Every day 08:00 Beirut (lv-dashboard top_sales): the last 7 days' units against the item's weekly average of the
--   8 weeks before (at least 1.5 times, at least 4 units more, and it did sell before). Saved here with the stock now
--   (one set per day, 14 days kept); push-alerts notifies once a day, only for the items newly flagged;
--   Vendors › Top sales shows the latest list.
-- Additive only: a new table and a new cron job.

create table if not exists public.top_sales (
  week_end date not null,          -- the last day of the 7 days looked at (yesterday of the run)
  code text not null,
  vendor_id text,
  supplier text,
  description text,
  sold_week numeric not null,      -- units sold in the 7 days
  usual_week numeric not null,     -- the weekly average of the 8 weeks before
  ratio numeric,
  stock numeric,                   -- in the system now (null: not read)
  days_left numeric,               -- stock at the week's daily rate
  created_at timestamptz not null default now(),
  primary key (week_end, code)
);
alter table public.top_sales enable row level security;
drop policy if exists top_sales_read on public.top_sales;
create policy top_sales_read on public.top_sales for select to authenticated using (public.has_perm('vendors.manage'));

do $$
begin
  if exists (select 1 from cron.job where jobname = 'top-sales') then perform cron.unschedule('top-sales'); end if;
end $$;
-- every day 05:00 UTC = 08:00 Beirut (07:00 in winter)
select cron.schedule('top-sales', '0 5 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"top_sales"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
