-- 025 — Sell-outs get a supplier; floor check items get a category (owner, 2026-10-01).
-- The sell-out files move to the store system's item report ("ItemPriceQty Report": Code, Description,
-- Group, Sub-Group, Sale Price, Bar Code, Supplier…): the floor check can then go category by category
-- (Group › Sub-Group). Existing rows keep null until their file is replaced / the check is refreshed.
-- ADDITIVE. The tables' existing grants and RLS cover the new columns.

alter table public.sellouts          add column if not exists supplier text;
alter table public.floor_check_items add column if not exists category text;
