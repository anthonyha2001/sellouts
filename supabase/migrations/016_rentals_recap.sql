-- 016 — Rentals list = a recap per supplier of what is assigned on the map (owner, 2026-09-29).
-- 1. Empty the list: remove the contracts copied from the old rentals list by 013 (all of them are
--    at $0; the owner re-assigns everything on the map). The old table vendor_rentals is NOT touched.
-- 2. Performance (monthly sales) now belongs to the supplier, not to one contract:
--    rental_supplier_sales, one row per supplier (name compared without case / outer spaces).
--    The old sales figures are not carried over (owner: start empty).

delete from public.rental_contracts where legacy_rental_id is not null;

-- 1b. Empty the map too (owner, 2026-09-29): the supplier names the traced plan wrote on the spots
--     ("occupant", shown as "Occupied, no contract") are cleared, so every spot starts free.
--     The layout itself (gondolas, sections, spots) is kept; earlier layout versions still hold the names.
update public.store_map_objects set occupant = null where coalesce(trim(occupant), '') <> '';

create table if not exists public.rental_supplier_sales (
  supplier_key   text primary key,               -- lower(trim(supplier)), how contracts are grouped
  supplier       text not null,                  -- the name as shown
  monthly_sales  jsonb not null default '{}',    -- {"2026-07": 20801, …}
  updated_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  check (supplier_key = lower(trim(supplier)))
);

alter table public.rental_supplier_sales enable row level security;
revoke all on public.rental_supplier_sales from anon;
revoke truncate, references, trigger on public.rental_supplier_sales from authenticated;
drop policy if exists rental_supplier_sales_read on public.rental_supplier_sales;
drop policy if exists rental_supplier_sales_write on public.rental_supplier_sales;
create policy rental_supplier_sales_read on public.rental_supplier_sales for select to authenticated
  using (public.has_perm('rentals.view'));
create policy rental_supplier_sales_write on public.rental_supplier_sales for all to authenticated
  using (public.has_perm('rentals.contracts')) with check (public.has_perm('rentals.contracts'));
