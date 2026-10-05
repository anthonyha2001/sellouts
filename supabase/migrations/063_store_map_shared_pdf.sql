-- 063 — Store map: the map PDF sent by email (owner, 2026-10-06).
--   "Email" on a rented / available spot saves the map PDF (the spot highlighted) under store-maps/shared/ and
--   sends a link valid 60 days. Whoever manages the contracts (rentals.contracts) can save and link those PDFs,
--   only in shared/ (the floor-plan images stay for rentals.layout, as before).
-- ADDITIVE (two storage policies).

drop policy if exists store_maps_shared_insert on storage.objects;
create policy store_maps_shared_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'store-maps' and name like 'shared/%' and public.has_perm('rentals.contracts', 'rentals.layout'));

drop policy if exists store_maps_shared_read on storage.objects;
create policy store_maps_shared_read on storage.objects for select to authenticated
  using (bucket_id = 'store-maps' and name like 'shared/%' and public.has_perm('rentals.contracts', 'rentals.layout', 'rentals.view'));
