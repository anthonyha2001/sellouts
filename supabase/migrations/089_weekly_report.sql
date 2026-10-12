-- 089 — The weekly report (owner, 2026-10-12): every Monday at 08:00 Beirut, lv-dashboard (weekly_report) puts last week (Monday to
--   Sunday) on one page and keeps it: sales against the week before (day by day), the sections that grew / fell most, the margin
--   watch, the big purchases, the stock to see to, the POs not delivered, the expiries of the coming week, the cash differences,
--   the rentals ending. Kept as it was on that Monday (data), so a past week reads the same later. push-alerts notifies it.
-- Additive only: a new table and a cron job.
create table if not exists public.weekly_reports (
  week_start date primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.weekly_reports enable row level security;
drop policy if exists weekly_reports_read on public.weekly_reports;
create policy weekly_reports_read on public.weekly_reports for select to authenticated using (public.has_perm('vendors.manage'));

do $$
begin
  if exists (select 1 from cron.job where jobname = 'weekly-report') then perform cron.unschedule('weekly-report'); end if;
end $$;
-- Mondays 04:50 UTC = 07:50 Beirut (ready for the 08:00 notification)
select cron.schedule('weekly-report', '50 4 * * 1', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"weekly_report"}'::jsonb,
    timeout_milliseconds := 140000)
$job$);
