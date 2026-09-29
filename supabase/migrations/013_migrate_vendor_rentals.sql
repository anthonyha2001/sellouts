-- 013 — Copy the old rentals (vendor_rentals) into rental_contracts (store-map/WIRING.md step 5).
-- Owner, 2026-09-29: every old rental becomes ONE yearly contract, amount 0 (the owner fills in the
-- real amount), same supplier, description and dates, NOT placed on the map (spot_id null) — the
-- owner places each one with "Place". The monthly figures are the supplier's sales: they move to
-- monthly_sales so the renew / review signal keeps working.
-- vendor_rentals is NOT changed or deleted. Safe to run twice (one contract per old rental).
-- Run after 012.

insert into public.rental_contracts
  (id, spot_id, supplier, term, start_date, end_date, amount, billed, billed_at, note,
   monthly_sales, legacy_rental_id, legacy_label, created_by)
select
  'rc-legacy-' || v.id,
  null,
  coalesce(nullif(trim(v.supplier), ''), 'Unknown supplier'),
  'yearly',
  coalesce(v.date_from, public.beirut_today()),
  greatest(coalesce(v.date_to, (coalesce(v.date_from, public.beirut_today()) + interval '1 year' - interval '1 day')::date),
           coalesce(v.date_from, public.beirut_today())),
  coalesce(v.annual_amount, 0),
  coalesce(v.billed, false),
  v.billed_at,
  v.note,
  case when v.monthly is null or v.monthly = '{}'::jsonb then null else v.monthly end,
  v.id,
  nullif(trim(v.gondola), ''),
  null
from public.vendor_rentals v
where not exists (select 1 from public.rental_contracts c where c.legacy_rental_id = v.id);
