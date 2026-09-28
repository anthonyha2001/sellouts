# Schema before the rebuild (Phase 0 snapshot, 2026-09-29)

Source: the Phase 0 data backup (`backups/2026-09-29-00-52`) and the code in `index.html` / `delivery.html`.
**Column types, constraints and RLS policies below are inferred, not confirmed.** The publishable key
cannot read the catalog. Run `docs/inspect-schema.sql` in the SQL Editor and paste the result into the
"Confirmed catalog" section at the end before Phase 1 SQL is written.

## Access today (verified 2026-09-29)

With only the publishable key (anyone who opens the page source has it), **every one of the 14 tables
returned all of its rows**. No login is involved. Writes were not tested, to avoid touching live data,
but both apps write with that same key, so insert/update/delete must be open as well.
The delivery app's comment claims `setup.sql` opens "only the dt_ tables", but the main-app tables
are readable too.

`setup.sql` is not in this folder. The confirmed catalog query will show the real policies.

## Conventions observed

- **Primary keys are client-generated text**, not uuid: `id-<base36>-<rand>` (main app), a 13-char base36
  string (delivery), numeric strings for `catalog_items` (e.g. `150966`), and `key` = `'app'` for `dt_settings`.
  New Phase 1 columns that reference users (`created_by`, `archived_by`, …) will be `uuid`, but existing ids stay text.
- Timestamps are ISO strings from the browser (`created_at`), dates are `YYYY-MM-DD` text/date.
- Files are stored as base64 inside rows (`sellouts.file_base64`, `promotions.source_file_base64`). Moving them to Storage is a parked idea (§12).
- Realtime: the delivery app subscribes to `postgres_changes` on `dt_drivers`, `dt_customers`, `dt_orders`, `dt_settings`.
  Realtime respects RLS, so the Phase 1 policies also decide who gets live updates.

## Tables

| Table | Rows | Columns seen (JS type in the data) |
|---|---|---|
| `sellouts` | 8 | id, name, **from**, **to** (reserved words as column names), file_name, file_base64, items (array of raw Excel rows), active (bool), log (array of `{at, action}`), notified_flags (object, e.g. `{startOverdue: date}`), created_at |
| `credit_notes` | 15 | id, number, supplier, details, status, created_at |
| `catalog_items` | 420 | id, code, description, pack, balance, sale_price, supplier, country, out_ytd, promotion_id (nullable → global or per-promotion catalog), updated_at |
| `app_settings` | 0 | read as `id='singleton'`, `low_stock_threshold` (number). Empty, so the app uses its default |
| `promotions` | 3 | id, name, from_date, to_date, archived, auto_archive, source_file_name, source_file_base64, created_at |
| `promotion_rows` | 472 | id, promotion_id, code, description, pack, balance, promo_price, discount, price_type, before_price, sale_price, flagged, reviewed, sort_order, supplier, cost (**text**), note, country, out_ytd, created_at |
| `vendors` | 170 | id, name, salesman_name, phone, day_of_week, frequency_weeks, lead_time_days, anchor_date, created_at |
| `vendor_orders` | 145 | id, vendor_id (nullable), vendor_name, order_date, lead_time_days, expected_delivery, status, delivered_date, created_at |
| `vendor_skips` | 19 | id, vendor_id (nullable), vendor_name, skip_date, created_at |
| `vendor_rentals` | 46 | id, supplier, gondola, date_from, date_to, monthly (object `{"YYYY-MM": amount}` over two years), created_at |
| `dt_drivers` | 2 | id, name, phone, created_at |
| `dt_customers` | 1847 | id, name, phone, area, address, created_at |
| `dt_orders` | 41 | id, created (epoch ms number), order_date, customer_id, c_name, c_phone, c_area, c_address (denormalised customer snapshot), driver_id, amount, platform, payment, paid, paid_at, note, created_at |
| `dt_settings` | 1 | key (`'app'`), value (`{areas, currency}`), updated_at |

## Notes for later phases

- **Phase 1:** `dt_orders.order_date` is the column the "today only" trigger compares with `beirut_today()`.
  The delivery `sync()` upserts whole rows, so the trigger must compare values rather than "which columns were sent".
  Unchanged columns must pass through.
- **Phase 2:** sell-out `items` rows already carry `Saleprice`, `Promotion`, `Balance`, `Description`, `Code`
  as raw Excel headers, so price-column detection can pre-select `Saleprice`.
- **Phase 3:** `vendor_rentals.gondola` is free text today; `equipment_type` will be added beside it (additive).

## Confirmed catalog

_To be filled from the output of `docs/inspect-schema.sql`._
