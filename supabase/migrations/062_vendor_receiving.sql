-- 062 — Vendors: receiving (owner, 2026-10-05).
--   An order received is marked with how (complete / partial), the supplier's invoice number, a note, who
--   received it and when. A new right "vendors.receive" lets someone (e.g. the warehouse keeper) see the
--   receiving calendar and the receiving page and mark orders received, without the rest of the vendors page.
-- ADDITIVE (new columns, one new permission). The table's access rules are not changed here.

alter table public.vendor_orders add column if not exists received_at timestamptz;
alter table public.vendor_orders add column if not exists received_by uuid;
alter table public.vendor_orders add column if not exists received_by_name text;
alter table public.vendor_orders add column if not exists receive_status text;
alter table public.vendor_orders add column if not exists invoice_no text;
alter table public.vendor_orders add column if not exists receive_note text;
do $$ begin
  alter table public.vendor_orders add constraint vendor_orders_receive_status_chk check (receive_status is null or receive_status in ('complete', 'partial'));
exception when duplicate_object then null; end $$;

insert into public.permissions (key, grp, label, sort) values
  ('vendors.receive', 'Vendors', 'Receiving: see the deliveries and mark orders received', 26)
on conflict (key) do nothing;
