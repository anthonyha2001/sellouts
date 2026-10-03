-- 037 — "See the store map, no amounts" (owner, 2026-10-03): floor managers see the map, who rents each
-- spot and until when, without the amounts, billing or payments.
--   rentals.map  : new permission (role floor_manager). Reads the floors, spots and map settings, and the
--                  contracts through rental_map_contracts() — supplier, spot, term and dates only.
--   rental_contracts itself (amounts, billed, paid, notes) is now read with rentals.view only; the spot
--   check (rentals.spotcheck) reads the same money-free list (js/modules/spotcheck.js).
-- ADDITIVE (new permission and function; read policies replaced with one more / one less permission).

insert into public.permissions (key, grp, label, sort)
values ('rentals.map', 'Rentals', 'See the store map: who rents each spot and until when (no amounts)', 1)
on conflict (key) do nothing;
insert into public.role_permissions (role, perm) values ('floor_manager', 'rentals.map')
on conflict do nothing;

drop policy if exists store_floors_read on public.store_floors;
create policy store_floors_read on public.store_floors for select to authenticated
  using (public.has_perm('rentals.view', 'rentals.map', 'rentals.spotcheck'));
drop policy if exists store_map_objects_read on public.store_map_objects;
create policy store_map_objects_read on public.store_map_objects for select to authenticated
  using (public.has_perm('rentals.view', 'rentals.map', 'rentals.spotcheck'));
drop policy if exists store_map_config_read on public.store_map_config;
create policy store_map_config_read on public.store_map_config for select to authenticated
  using (public.has_perm('rentals.view', 'rentals.map', 'rentals.spotcheck'));

-- Amounts, billing and payments: only with rentals.view (was also rentals.spotcheck).
drop policy if exists rental_contracts_read on public.rental_contracts;
create policy rental_contracts_read on public.rental_contracts for select to authenticated
  using (public.has_perm('rentals.view'));

-- The contracts without money: for the map-only view and the spot check.
create or replace function public.rental_map_contracts()
returns table (id text, spot_id text, supplier text, term text, start_date date, end_date date)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_perm('rentals.view', 'rentals.map', 'rentals.spotcheck') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query select c.id, c.spot_id, c.supplier, c.term, c.start_date, c.end_date
    from public.rental_contracts c order by c.start_date;
end $$;
revoke execute on function public.rental_map_contracts() from public, anon;
grant execute on function public.rental_map_contracts() to authenticated;

-- Floor managers given the full Rentals view one by one (elio): the map without amounts instead (owner, 2026-10-03).
delete from public.user_permissions up using public.profiles p
 where up.user_id = p.id and p.role = 'floor_manager' and up.perm = 'rentals.view' and up.allowed;
