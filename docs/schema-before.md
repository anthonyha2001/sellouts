# Schema before the rebuild (Phase 0 snapshot, 2026-09-29)

Sources: `docs/inspect-schema.sql` run read-only against the live database on 2026-09-29 (raw output:
`docs/schema-before.json`), plus the data backup and the two HTML files.

## Access today (confirmed from the database catalog)

- **RLS is enabled on all 15 tables, but every table has a policy that allows everything to everyone:**
  - `public access` (ALL, role `public`, `using true`, `check true`): app_settings, catalog_items, credit_notes, promotions, promotion_rows, sellouts
  - `vendors_all` / `vendor_orders_all` / `vendor_skips_all` / `vendor_rentals_all` (ALL, `public`, `true`): the vendor tables
  - `dt_app_all` (ALL, `anon, authenticated`, `true`): dt_customers, dt_drivers, dt_orders, dt_settings
  - `dt_staff_read_self` (SELECT, authenticated, `user_id = auth.uid()`): dt_staff, the only restrictive one
- **Grants:** `anon` and `authenticated` hold every privilege on every table, including TRUNCATE (not reachable through the
  REST API, but still wrong).
- **Triggers:** none. **Functions:** only `dt_is_staff()` (security definer, unused by the app).
- **Indexes (besides PKs):** `dt_customers(phone)`, `dt_orders(order_date)`, `dt_orders(driver_id) where not paid`.
- **Check / unique constraints:** none besides PKs and FKs.
- **Realtime publication:** dt_drivers, dt_customers, dt_orders, dt_settings.
- **Extensions:** plpgsql, pgcrypto (needed for cashier PINs, Phase 4), uuid-ossp, pg_stat_statements, supabase_vault.
- **Auth users: 0. Storage buckets: 0.** Server timezone: UTC (Postgres 17.6).
- `dt_staff` + `dt_is_staff()` are an earlier, unused staff-lock attempt, superseded by `profiles`, and left in place.

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

1. Migration starts by copying `pg_policies` into `_policy_backup_20260929`, then drops the open policies listed above,
   revokes all `anon` privileges (and TRUNCATE/TRIGGER/REFERENCES from `authenticated`), and creates the §3 policies.
2. `dt_orders.order_date` defaults to `CURRENT_DATE`, which is the **UTC** date on Supabase. Between 00:00 and 03:00 Beirut
   time that is yesterday. The app always sends `order_date` today, but the default will change to `beirut_today()`.
3. The delivery `sync()` upserts whole rows, so the "today only" trigger compares old and new values column by column.
   Unchanged columns must pass.
4. Upsert with a conflict = INSERT + UPDATE, so delivery users need both INSERT and UPDATE policies on `dt_orders`,
   and the trigger (not the policy) does the "only paid/paid_at on older orders" check.

## Notes for later phases

- **Phase 2:** sell-out `items` already carry `Saleprice`, so price-column detection can pre-select it.
- **Phase 3:** `vendor_rentals.gondola` is free text; `equipment_type` will be added beside it.
