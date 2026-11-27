-- 108 — Promotions › Purchase (owner, 2026-11-27): each promotion row gets a Promo cost, typed by hand next to the
-- item's cost and quantity, and exported to Excel. ADDITIVE. The table's grants, RLS and promotion_rows_perm_guard
-- already cover the new column (only promotions.edit may change it).

alter table public.promotion_rows add column if not exists promo_cost numeric;
