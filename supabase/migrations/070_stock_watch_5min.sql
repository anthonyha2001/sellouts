-- 070 — Low stock for every active supplier (owner, 2026-10-06): 142 vendors watched, so the stock watch runs every
--   5 minutes from 07:00 to 19:00 Beirut (each run works 90 s on the vendors checked longest ago): each vendor about
--   7 times a day. Same job as 066, more often.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'stock-watch') then perform cron.unschedule('stock-watch'); end if;
end $$;
-- 04:00 – 15:55 UTC = 07:00 – 18:55 Beirut
select cron.schedule('stock-watch', '*/5 4-15 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"stock_watch"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
