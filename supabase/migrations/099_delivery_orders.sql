-- 099 — Delivery department, pre-computed (owner, 2026-10-23): like Sales by hour, the delivery orders are read in the
--   background and kept here so the page is instant (reading ~850 invoices live timed out). A cron calls lv-dashboard
--   delivery_sync every 10 minutes: it lists each branch's delivery invoices (the fee items 158147 / 158146 in the cardex)
--   and reads each invoice's full total (the basket) a batch at a time. The page reads this table; nothing live.
-- One row per delivery invoice. total/currency null until its basket has been read (the cron fills them over a few runs).
create table if not exists public.delivery_orders (
  branch    text not null,
  year      text not null,
  invoice   text not null,                 -- the document code, e.g. T10003633 (for display / dedup)
  doc_type  text,                           -- for the viewer: the 2-char type, e.g. T1
  doc_num   text,                           -- for the viewer: the number, e.g. 0003633
  day       date,
  customer  text,
  fee       numeric,                        -- the delivery fee on this invoice (its own currency)
  total     numeric,                        -- the full basket (incl. VAT), null until read
  currency  text,
  read_at   timestamptz,                    -- when the basket was read
  seen_at   timestamptz not null default now(),
  primary key (branch, year, invoice)
);
create index if not exists delivery_orders_branch_day on public.delivery_orders (branch, day);
create index if not exists delivery_orders_unread on public.delivery_orders (read_at) where read_at is null;

alter table public.delivery_orders enable row level security;
revoke all on public.delivery_orders from anon;
grant select on public.delivery_orders to authenticated;   -- the cron writes with the service role; no client writes
drop policy if exists delivery_orders_read on public.delivery_orders;
create policy delivery_orders_read on public.delivery_orders for select to authenticated using (public.has_perm('vendors.manage'));

-- every 10 minutes, 07:00–21:00 Beirut: list the invoices and read a batch of baskets
do $$ begin if exists (select 1 from cron.job where jobname = 'delivery-sync') then perform cron.unschedule('delivery-sync'); end if; end $$;
select cron.schedule('delivery-sync', '*/10 4-18 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"delivery_sync"}'::jsonb,
    timeout_milliseconds := 150000)
$job$);
