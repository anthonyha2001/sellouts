-- 077 — Warehouse opening days (owner, 2026-10-11).
-- The receiving warehouse is closed on Saturdays and Sundays; it opens some Saturdays, never a Sunday.
-- A row here = a Saturday that is OPEN (deleted again when it is not). Sundays are never open, rows for them are ignored.
-- The app (js/modules/warehouse.js) moves expected deliveries that land on a closed day to the next open day.
-- Additive only: one new table.

create table if not exists public.warehouse_days (
  day date primary key,
  open boolean not null default true,
  note text,
  set_by uuid references auth.users on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.warehouse_days enable row level security;

drop policy if exists warehouse_days_read on public.warehouse_days;
create policy warehouse_days_read on public.warehouse_days for select to authenticated
  using (public.has_perm('vendors.manage') or public.has_perm('vendors.receive'));
drop policy if exists warehouse_days_write on public.warehouse_days;
create policy warehouse_days_write on public.warehouse_days for all to authenticated
  using (public.has_perm('vendors.manage')) with check (public.has_perm('vendors.manage'));
