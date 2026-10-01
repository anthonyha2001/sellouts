-- 029 — A promotion row whose item is already on a sell-out shows in purple with a "Sell-out" badge;
-- the owner can override that mark per row (owner, 2026-10-01). This keeps the override.
-- ADDITIVE. The table's grants and RLS cover the new column.

alter table public.promotion_rows add column if not exists sellout_ok boolean not null default false;
