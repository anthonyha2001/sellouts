# Schema before the rebuild (Phase 0 snapshot, 2026-09-29)

Sources: the live REST API schema (read with the secret key: exact columns, types, defaults, NOT NULL,
primary and foreign keys), the Auth and Storage admin APIs, the data backup, and the two HTML files.
**Not visible without direct SQL:** RLS policy text, grants, triggers, indexes and non-exposed functions.
Phase 1 handles this by saving `pg_policies` into a backup table before replacing the policies
(see "Plan for Phase 1" below). `docs/inspect-schema.sql` can still be run in the SQL Editor for the full picture.

## Access today (verified 2026-09-29)

- **Anyone with the publishable key (it is in the page source) can read all 15 tables.** Writes were not tested,
  to avoid touching live data, but both apps write with that same key, so insert/update/delete are open as well.
- **Auth: 0 users.** Nobody has ever logged in.
- **Storage: 0 buckets.** Files live as base64 inside rows.
- `dt_staff` (empty) + RPC `dt_is_staff()` (returns `false` for anon) are an unused, earlier attempt at a delivery
  staff lock. The `dt_*` policies clearly do not depend on it today, since anon reads everything. `setup.sql` is not in the folder.
  Phase 1 supersedes it with `profiles` and leaves both in place (additive rule), unless you approve dropping them.
- Realtime: the delivery app subscribes to `postgres_changes` on `dt_drivers`, `dt_customers`, `dt_orders`, `dt_settings`.
  Realtime respects RLS, so the Phase 1 policies also decide who receives live updates.

## Conventions

- **Primary keys are client-generated `text`**, not uuid: `id-<base36>-<rand>` (main app), 13-char base36 (delivery),
  numeric strings in `catalog_items`, and `key='app'` for `dt_settings`. New columns referencing users will be `uuid`.
- Files are stored as base64 in rows (`sellouts.file_base64`, `promotions.source_file_base64`). Moving them to Storage is parked (§12).

## Tables (confirmed)

`PK` = primary key, `FK→` = foreign key, `NN` = not null. Row counts from the 2026-09-29 backup.

### Main app

**`sellouts`** (8): `id` text PK · `name` text · `from` date · `to` date (reserved-word names, quote in SQL) ·
`file_name` text · `file_base64` text · `items` jsonb (raw Excel rows, e.g. `{Code, Description, Saleprice, Promotion, Balance}`) ·
`active` bool = false · `log` jsonb (`[{at, action}]`) · `notified_flags` jsonb · `created_at` timestamptz = now()

**`credit_notes`** (15): `id` text PK · `number` text · `supplier` text · `details` text · `status` text = 'issued' · `created_at` timestamptz = now()

**`catalog_items`** (420): `id` text PK · `code` text · `description` text · `pack` text · `balance` numeric · `sale_price` numeric ·
`supplier` text · `country` text · `out_ytd` numeric · `promotion_id` text FK→promotions.id (null = global catalog) · `updated_at` timestamptz = now()

**`app_settings`** (0): `id` text PK (app uses `'singleton'`) · `low_stock_threshold` numeric = 20

**`promotions`** (3): `id` text PK · `name` text · `from_date` date · `to_date` date · `archived` bool NN = false ·
`auto_archive` bool NN = true · `source_file_name` text · `source_file_base64` text · `created_at` timestamptz = now()

**`promotion_rows`** (472): `id` text PK · `promotion_id` text FK→promotions.id · `code` · `description` · `pack` text ·
`balance` · `promo_price` · `discount` · `before_price` · `sale_price` · `out_ytd` numeric · `price_type` · `supplier` · `country` · `note` text ·
`cost` **text** · `flagged` bool = false · `reviewed` bool = false · `sort_order` int = 0 · `created_at` timestamptz = now()

**`vendors`** (170): `id` text PK · `name` text NN · `salesman_name` · `phone` text · `day_of_week` int · `frequency_weeks` int NN = 1 ·
`lead_time_days` int · `anchor_date` date · `created_at` timestamptz NN = now()

**`vendor_orders`** (145): `id` text PK · `vendor_id` text FK→vendors.id · `vendor_name` text · `order_date` date · `lead_time_days` int ·
`expected_delivery` date · `status` text NN = 'pending' · `delivered_date` date · `created_at` timestamptz NN = now()

**`vendor_skips`** (19): `id` text PK · `vendor_id` text FK→vendors.id · `vendor_name` text · `skip_date` date NN · `created_at` timestamptz NN = now()

**`vendor_rentals`** (46): `id` text PK · `supplier` text NN · `gondola` text · `date_from` date · `date_to` date ·
`monthly` jsonb NN (`{"YYYY-MM": amount}` across two years) · `created_at` timestamptz NN = now()

### Delivery app

**`dt_drivers`** (2): `id` text PK · `name` text NN · `phone` text = '' · `created_at` timestamptz NN = now()

**`dt_customers`** (1847): `id` text PK · `name` text NN · `phone` · `area` · `address` text = '' · `created_at` timestamptz NN = now()

**`dt_orders`** (41): `id` text PK · `created` bigint NN = 0 (epoch ms) · `order_date` date NN = **CURRENT_DATE** ·
`customer_id` text · `c_name` text NN = '' · `c_phone` · `c_area` · `c_address` text = '' (customer snapshot; **no FK**) ·
`driver_id` text (**no FK**) · `amount` numeric NN = 0 · `platform` text NN = 'WhatsApp' · `payment` text NN = 'Cash' ·
`paid` bool NN = false · `paid_at` date · `note` text = '' · `created_at` timestamptz NN = now()

**`dt_settings`** (1): `key` text PK · `value` jsonb NN (`{areas, currency}`) · `updated_at` timestamptz NN = now()

**`dt_staff`** (0): `user_id` uuid PK · `email` text · `created_at` timestamptz NN = now()

**RPC:** `dt_is_staff()` → boolean.

## Plan for Phase 1 (from these findings)

1. Migration starts with `create table _policy_backup_20260929 as select … from pg_policies where schemaname='public'`,
   so the old policies are recorded before they are replaced. Then all existing policies on these tables are dropped
   in a loop, and the §3 policies are created.
2. `dt_orders.order_date` defaults to `CURRENT_DATE`, which is the **UTC** date on Supabase. Between 00:00 and 03:00 Beirut
   time that is yesterday. The app always sends `order_date` today, but the default will change to `beirut_today()`.
3. The delivery `sync()` upserts whole rows, so the "today only" trigger compares old and new values column by column.
   Unchanged columns must pass.
4. Upsert with a conflict = INSERT + UPDATE, so delivery users need both INSERT and UPDATE policies on `dt_orders`,
   and the trigger (not the policy) does the "only paid/paid_at on older orders" check.

## Notes for later phases

- **Phase 2:** sell-out `items` already carry `Saleprice`, so price-column detection can pre-select it.
- **Phase 3:** `vendor_rentals.gondola` is free text; `equipment_type` will be added beside it.
