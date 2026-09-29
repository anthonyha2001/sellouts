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

-- Gondola, side gondola, basket side and pillar can be yearly or monthly ("other");
-- screens (wall / island) are monthly only (owner, 2026-09-29).
alter table public.vendor_rentals drop constraint if exists vendor_rentals_equipment_check;
alter table public.vendor_rentals add constraint vendor_rentals_equipment_check check (
  equipment_type in ('gondola', 'side_gondola', 'basket_side', 'pillar', 'screen_wall', 'screen_island')
  and (rental_term = 'other' or equipment_type not in ('screen_wall', 'screen_island'))
);
