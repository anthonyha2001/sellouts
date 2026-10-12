-- 091 — The monthly supplier report (owner, 2026-10-12): one page per supplier and month, no cost and no margin: their sales and
--   units against the month before, their best items, the items that did not sell, their sell-outs, their rented spots. Made
--   from the vendor sheet and kept as it was made (data). A private link opens it without signing in: the token (a long random
--   value) is the key, read only, through lv-dashboard (supplier_report_view) - the table itself is never open to the public.
-- Additive only: a new table.
create table if not exists public.supplier_reports (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default (md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text)),
  vendor_id text,
  vendor_name text,
  month date not null,
  data jsonb not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists supplier_reports_vendor on public.supplier_reports (vendor_id, month desc);
alter table public.supplier_reports enable row level security;
drop policy if exists supplier_reports_staff on public.supplier_reports;
create policy supplier_reports_staff on public.supplier_reports for all to authenticated
  using (public.has_perm('vendors.manage')) with check (public.has_perm('vendors.manage'));
