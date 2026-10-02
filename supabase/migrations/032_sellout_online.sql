-- 032 — Sell-outs that run only online (owner, 2026-10-02): shown purple on the Sell-outs page.
-- ADDITIVE. The table's existing grants and RLS cover the new column.

alter table public.sellouts add column if not exists online boolean not null default false;
