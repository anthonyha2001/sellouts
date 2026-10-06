-- 065 — The price watch keeps each item's category too (owner, 2026-10-06).
--   The floor check groups items by category; promotion rows have none of their own, so they all fell under
--   "No category". The nightly watch (the same items: running sell-outs and promotions) now keeps the system's
--   Group › Sub-group, and the floor check uses it.
-- ADDITIVE (one column).

alter table public.item_price_watch add column if not exists category text;
