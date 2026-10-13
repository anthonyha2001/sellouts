-- 094 — Auto-receive from a new PU (owner, 2026-10-13): when an order is sent (status 'pending') and the system then shows a
--   new purchase (PU) from that supplier dated on/after the order was sent, the order is flagged delivered by itself and the
--   vendors managers are notified to confirm or undo. The auto flag marks it apart from a human receive, and it is fully
--   reversible. Detection: lv-dashboard 'auto_receive' on a cron; the notification: push-alerts (once per order).
-- Additive only: two columns and one cron job.
alter table public.vendor_orders add column if not exists auto_received    boolean not null default false;
alter table public.vendor_orders add column if not exists auto_received_pu  text;      -- "PU0011234 · 13-10 · $4,200"

-- every 20 minutes from 07:00 to 21:00 Beirut (04:00 – 18:40 UTC): flag the sent orders whose supplier has a new PU
do $$
begin
  if exists (select 1 from cron.job where jobname = 'auto-receive') then perform cron.unschedule('auto-receive'); end if;
end $$;
select cron.schedule('auto-receive', '*/20 4-18 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"auto_receive"}'::jsonb,
    timeout_milliseconds := 110000)
$job$);
