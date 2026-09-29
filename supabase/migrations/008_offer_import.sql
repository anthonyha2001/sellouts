-- 008 — AI offer import (PLAN §10): barcodes on catalog items and promotion rows, and a private
-- bucket for the supplier offer files saved with a promotion.
-- ADDITIVE ONLY.

-- Catalog: an item can have several barcodes (kept as text: leading zeros matter).
alter table public.catalog_items add column if not exists barcodes text[];
create index if not exists catalog_items_barcodes_idx on public.catalog_items using gin (barcodes);

-- Promotion rows: the barcode the line came with (price sheet / offer import). Also used by the
-- floor check scanner later (Phase 7).
alter table public.promotion_rows add column if not exists barcode text;

-- Offer files (PDF / photos / screenshots): promotion-offers/<promotion id>/<time>-<file name>. Admin only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('promotion-offers', 'promotion-offers', false, 20971520,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists promotion_offers_admin_select on storage.objects;
create policy promotion_offers_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'promotion-offers' and public.is_role('admin'));
drop policy if exists promotion_offers_admin_insert on storage.objects;
create policy promotion_offers_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'promotion-offers' and public.is_role('admin'));
drop policy if exists promotion_offers_admin_delete on storage.objects;
create policy promotion_offers_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'promotion-offers' and public.is_role('admin'));
