-- 009 — Remove the AI offer import's storage rules (owner, 2026-09-29: the AI offer import is not wanted).
-- 008's barcode columns stay (catalog_items.barcodes, promotion_rows.barcode): they are used by
-- the catalog upload, "Import price sheet" and the Phase 7 scanner.
-- The empty 'promotion-offers' bucket itself is deleted through the Storage API (Supabase does not
-- allow deleting buckets from SQL): DELETE /storage/v1/bucket/promotion-offers with the secret key.

drop policy if exists promotion_offers_admin_select on storage.objects;
drop policy if exists promotion_offers_admin_insert on storage.objects;
drop policy if exists promotion_offers_admin_delete on storage.objects;
