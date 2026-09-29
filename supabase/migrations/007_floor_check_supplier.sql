-- 007 — Floor check items get a supplier, so the check can be grouped by supplier (owner, 2026-09-29).
-- ADDITIVE: one new column, filled for checks that already exist.
--   promotion items: the supplier on the promotion row they came from
--   sell-out items:  the sell-out's name (sell-out files have no supplier column; one sell-out = one supplier's offer)

alter table public.floor_check_items add column if not exists supplier text;

update public.floor_check_items i
   set supplier = nullif(trim(r.supplier), '')
  from public.promotion_rows r
 where i.supplier is null and i.source = 'promotion' and i.item_key = 'pr:' || r.id;

update public.floor_check_items
   set supplier = coalesce(source_name, 'No supplier')
 where supplier is null;
