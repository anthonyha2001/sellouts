-- 078 — Receiving days per vendor (owner, 2026-10-11).
-- vendors.receiving_days: the weekdays (0 = Sunday … 6 = Saturday) the warehouse receives this supplier.
-- Empty / null = any open day after the lead time. The app picks the first of these days on or after
-- order date + lead time, skipping the days the warehouse is closed (Sunday; Saturday unless opened, 077).
-- Additive only: one new column.
alter table public.vendors add column if not exists receiving_days integer[];
