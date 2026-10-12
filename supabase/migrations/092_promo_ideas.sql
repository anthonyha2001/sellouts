-- 092 — Promotion ideas (owner, 2026-10-12): the items worth putting on promotion, kept as last made (lv-dashboard promo_ideas):
--   expiring within 30 days (Expiries), stopped selling (stock, no sale in 30 days, sold in the 60 before), overstocked (more than
--   120 days of stock at the last 30 days' pace), bought far above the usual (big purchases). Ranked by the money in stock, with
--   a suggested price that keeps a margin. One row (id 1), made again on request. Pricing › Promotion ideas.
-- Additive only: a new table.
create table if not exists public.promo_ideas (
  id integer primary key default 1 check (id = 1),
  data jsonb not null,
  made_at timestamptz not null default now()
);
alter table public.promo_ideas enable row level security;
drop policy if exists promo_ideas_read on public.promo_ideas;
create policy promo_ideas_read on public.promo_ideas for select to authenticated using (public.has_perm('vendors.manage'));
