-- 086 — Sales by hour and by section (owner, 2026-10-12). The system's reports stop at the day (Daily / Weekly / Monthly) and its
--   invoices carry no time, so the hours are measured: every 15 minutes lv-dashboard (sales_snapshot) reads TODAY's sales by section
--   and keeps them when they changed. What a section sold between two snapshots is what it sold in those minutes, so the
--   hours exist from the day this runs (past days cannot be rebuilt). A snapshot is the running total of the day, per section
--   (section '*' = the whole store). Additive only: a new table and a cron job.
create table if not exists public.sales_snapshots (
  day date not null,
  taken_at timestamptz not null,
  section text not null,
  section_desc text,
  sales numeric not null default 0,
  qty numeric not null default 0,
  primary key (day, taken_at, section)
);
create index if not exists sales_snapshots_day on public.sales_snapshots (day, taken_at);
alter table public.sales_snapshots enable row level security;
drop policy if exists sales_snapshots_read on public.sales_snapshots;
create policy sales_snapshots_read on public.sales_snapshots for select to authenticated using (public.has_perm('vendors.manage'));

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sales-snapshot') then perform cron.unschedule('sales-snapshot'); end if;
end $$;
-- every 15 minutes, 04:00 – 21:45 UTC = 07:00 – 00:45 Beirut (the store's day and its last sync)
select cron.schedule('sales-snapshot', '*/15 4-21 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"sales_snapshot"}'::jsonb,
    timeout_milliseconds := 60000)
$job$);
