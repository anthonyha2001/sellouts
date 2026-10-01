-- 028 — Promotion rows can be marked "To order" (instead of the flag), and the item catalog keeps "Last Purchase Date" and "Last Invoice Date" from the Excel file
-- (owner, 2026-10-01), shown with Balance and "Out" in the supplier line of a promotion row. Kept as the date text (dd/mm/yyyy).
-- ADDITIVE. The table's grants and RLS cover the new columns.

alter table public.catalog_items add column if not exists last_purchase_date text;
alter table public.catalog_items add column if not exists last_invoice_date  text;
alter table public.promotion_rows add column if not exists to_order boolean not null default false;
