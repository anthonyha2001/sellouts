-- 108 — Promotions › Purchase (owner, 2026-11-27): each promotion row gets a Promo cost, typed by hand next to the
-- item's cost and quantity, and exported to Excel. Free text (owner, 2026-11-27: it can be "1.10 + 10% free", etc.).
-- ADDITIVE. The table's grants, RLS and promotion_rows_perm_guard already cover the new column
-- (only promotions.edit may change it). If an earlier version of this file already made it numeric, it becomes text.

alter table public.promotion_rows add column if not exists promo_cost text;
alter table public.promotion_rows alter column promo_cost type text using promo_cost::text;
