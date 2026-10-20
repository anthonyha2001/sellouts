-- 097 — Returns: the PT's reference (owner, 2026-10-20). Each PT document carries a reference on its lines (reference_no);
--   the returns page shows it and searches it. Filled by lv-dashboard (pts_sync reads up to 20 PTs a run; the page asks for
--   the missing ones with pts_refs). null = not read yet, '' = the PT has no reference.
-- Additive only: one column.
alter table public.pts add column if not exists refs text;

-- A notification for every new return (owner, 2026-10-20; push-alerts): the returns are read every 15 minutes (was 30),
-- 07:00–21:00 Beirut, so the notice comes soon after the PT is entered.
do $$ begin if exists (select 1 from cron.job where jobname = 'pts-sync') then perform cron.unschedule('pts-sync'); end if; end $$;
select cron.schedule('pts-sync', '*/15 4-18 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"pts_sync"}'::jsonb,
    timeout_milliseconds := 150000)
$job$);
