-- 082 — The system's purchase orders (owner, 2026-10-11): an item out of stock that is already on a PO is flagged.
--   system_pos      : the POs of the week read from the system (/wms/purchase-orders): number, day, supplier, totals.
--   system_po_lines : their item lines (the document viewer). received_on = the day a PU of that item was entered on or
--                     after the PO's day (the PO's status stays "draft" in the system, it cannot tell).
--   delivered_on (PO) = the first day a PU of one of its items came in: the supplier delivered. Its lines with no PU are
--                     then NOT DELIVERED; their stock is read (stock_now): still out of stock = Stock control › Not available,
--                     to ask the supplier (kept 30 days, or until a PU of the item comes in).
--   Every 30 minutes from 07:00 to 20:00 Beirut (lv-dashboard po_sync). Read by Stock control and the vendor sheet.
-- Additive only: two tables and a cron job.

create table if not exists public.system_pos (
  po text primary key,                 -- PO0001026
  year text,
  po_date date not null,
  supplier_code text,
  supplier_name text,
  status text,
  line_count integer,
  requested_qty numeric,
  received_qty numeric,
  remaining_qty numeric,
  delivered_on date,                   -- the first PU of one of its items on or after the PO day (null: not delivered)
  lines_read_at timestamptz,
  seen_at timestamptz not null default now()
);
create index if not exists system_pos_day on public.system_pos (po_date);

create table if not exists public.system_po_lines (
  po text not null references public.system_pos (po) on delete cascade,
  line integer not null,
  po_date date not null,
  supplier_code text,
  supplier_name text,
  code text not null,                  -- the item code (today's codes)
  description text,
  qty numeric,
  unit_price numeric,
  received_on date,                    -- a PU of the item on or after the PO day (null = not received)
  po_delivered_on date,                -- the PO was delivered (copy of system_pos.delivered_on): no PU of this item = not delivered
  stock_now numeric,                   -- the stock of a line not delivered (read by po_sync)
  stock_read_at timestamptz,
  read_at timestamptz not null default now(),
  primary key (po, line)
);
create index if not exists system_po_lines_code on public.system_po_lines (code);
create index if not exists system_po_lines_open on public.system_po_lines (po_date) where received_on is null;

alter table public.system_pos enable row level security;
alter table public.system_po_lines enable row level security;
drop policy if exists system_pos_read on public.system_pos;
create policy system_pos_read on public.system_pos for select to authenticated using (public.has_perm('vendors.manage'));
drop policy if exists system_po_lines_read on public.system_po_lines;
create policy system_po_lines_read on public.system_po_lines for select to authenticated using (public.has_perm('vendors.manage'));

do $$
begin
  if exists (select 1 from cron.job where jobname = 'po-sync') then perform cron.unschedule('po-sync'); end if;
end $$;
-- every 30 minutes, 04:00–17:30 UTC = 07:00–20:30 Beirut (an hour earlier in winter)
select cron.schedule('po-sync', '*/30 4-17 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"po_sync"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
