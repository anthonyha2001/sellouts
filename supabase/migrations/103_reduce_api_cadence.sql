-- Reduce the calls to the La Valeur ERP API (owner's request, 2026-11-02): every
-- background job that READS the ERP now runs at most 5 times a day.
--
-- The poll-style jobs (watch / sync of the current state) move to 5 fixed times:
--   daytime  -> 05:00, 08:00, 11:00, 14:00, 17:00 UTC
--               = Beirut 08:00–20:00 (summer) / 07:00–19:00 (winter)
--   overnight-> 22:00, 23:00, 01:00, 02:00, 03:00 UTC  (the price-watch window)
--
-- Left as they are (already within the cap, or they do NOT touch the ERP):
--   weekly-report (weekly), top-sales-* and stock-review-* (once a day),
--   push-alerts / push-log-cleanup (database + web push only, no ERP).
--
-- NOT changed here: stock-snapshot. It is not a repeated poll — it is a nightly
-- full-catalog crawl (~210 short runs to read ~150,000 item stocks, each run
-- reading as many as fit in ~85 s). It cannot cover the catalog in 5 runs, so
-- cutting it to 5 would quietly leave the Overstock / Slow-moving review and the
-- Warehouse stock-change figures working off a small slice of the store. Kept as
-- is pending the owner's decision (see the commit message / hand-off).
--
-- Only the schedule changes; each job keeps its existing command (cron.alter_job).

do $$
declare
  daytime   text := '0 5,8,11,14,17 * * *';
  overnight text := '0 22,23,1,2,3 * * *';
  plan jsonb := jsonb_build_object(
    'stock-watch',    daytime,   -- was every 5 min  (~144/day)
    'big-buys',       daytime,   -- was every 30 min (~24/day)
    'po-sync',        daytime,   -- was every 30 min (~28/day)
    'pts-sync',       daytime,   -- was every 15 min (~60/day)
    'delivery-sync',  daytime,   -- was every 10 min (~90/day)
    'margin-watch',   daytime,   -- was every 10 min (~84/day)
    'sales-snapshot', daytime,   -- was every 15 min (~72/day) — the By-hour chart is now 5 points a day
    'auto-receive',   daytime,   -- was every 20 min (~45/day)
    'price-watch',    overnight  -- was every 15 min overnight (~24/day)
  );
  k text; v text; jid bigint;
begin
  for k, v in select * from jsonb_each_text(plan) loop
    select jobid into jid from cron.job where jobname = k;
    if jid is not null then
      perform cron.alter_job(jid, schedule := v);
      raise notice 'rescheduled % -> %', k, v;
    else
      raise notice 'job % not found, skipped', k;
    end if;
  end loop;
end $$;
