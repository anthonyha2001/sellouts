-- 004 — Rentals: yearly vs other contracts, equipment type, annual amount, billing, note (PLAN §7.1).
-- ADDITIVE ONLY. Existing rows become term 'other' + equipment 'gondola' through the column
-- defaults; the admin corrects them afterwards on the Rentals page. `monthly` and `gondola`
-- (the free-text description) are kept as they are.

alter table public.vendor_rentals add column if not exists rental_term    text not null default 'other';
alter table public.vendor_rentals add column if not exists equipment_type text not null default 'gondola';
alter table public.vendor_rentals add column if not exists annual_amount  numeric;           -- yearly only
alter table public.vendor_rentals add column if not exists billed         boolean not null default false;  -- yearly only
alter table public.vendor_rentals add column if not exists billed_at      date;              -- yearly only
alter table public.vendor_rentals add column if not exists note           text;

alter table public.vendor_rentals drop constraint if exists vendor_rentals_term_check;
alter table public.vendor_rentals add constraint vendor_rentals_term_check
  check (rental_term in ('yearly', 'other'));

-- Yearly contracts are for gondolas or side gondolas; other rentals are gondola, basket side or screens.
alter table public.vendor_rentals drop constraint if exists vendor_rentals_equipment_check;
alter table public.vendor_rentals add constraint vendor_rentals_equipment_check check (
  (rental_term = 'yearly' and equipment_type in ('gondola', 'side_gondola'))
  or (rental_term = 'other' and equipment_type in ('gondola', 'basket_side', 'screen_wall', 'screen_island'))
);
