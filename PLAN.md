# LV Ajaltoun — Build Plan

This file is the source of truth for the project. Read it fully at the start of every session. Work phase by phase, in order. Do not start a phase until the previous one is finished, tested, and committed.

---

## 1. Context

**Business:** LV Ajaltoun, a supermarket in Ajaltoun, Lebanon. Timezone **Asia/Beirut**. All "today" logic must use the local date, never UTC.

**Current state: two separate single-file web apps sharing one Supabase project.**

| File | What it is |
|---|---|
| Main app (e.g. `index.html`) | Sidebar app with: Sell-Outs, Credit Notes, Promotions, Vendors (Directory + Orders), Rentals |
| Delivery app (e.g. `delivery.html`) | Delivery Tracker: Orders (keyboard quick-entry row), Driver payments, Reports, Customers, Drivers, Settings |

**Tech:** vanilla HTML/CSS/JS, no build step. SheetJS `xlsx@0.18.5`, `@supabase/supabase-js@2`. Hosted as static files.

**Supabase project:** `https://sezjqcbkiydckhirycjb.supabase.co`. The frontend uses only the publishable key.

**Existing tables** (verify the real schema in Supabase before changing anything; do not trust this list blindly):
- Main app: `sellouts`, `credit_notes`, `catalog_items`, `app_settings`, `promotions`, `promotion_rows`, `vendors`, `vendor_orders`, `vendor_skips`, `vendor_rentals`
- Delivery app: `dt_drivers`, `dt_customers`, `dt_orders`, `dt_settings`

**Security problem to fix:** there is no login today. Anyone with a page link can read, change, and delete everything. The delivery app even has "Delete all data" and "Restore backup" open to all.

---

## 2. Working rules

1. **Never lose existing data.** Migrations are additive: add columns and tables, never drop or rename without explicit approval. Back up before every phase that touches the schema.
2. **SQL lives in files:** `supabase/migrations/NNN_description.sql`, numbered in order. Show me the SQL and wait for approval before running anything against the live database.
3. **Never put secret keys in frontend code.** Only the publishable key goes in the page. Anything needing a secret (creating users, AI calls, the cashier PIN check) runs in a Supabase Edge Function.
4. **Permissions are enforced by the database (RLS), not only by hiding UI.** Hiding a button is cosmetic; the RLS policy is the real rule.
5. **Keep the no-build-step setup.** Splitting into multiple `.js`/`.css` files loaded by `index.html` is fine and encouraged; bundlers are not.
6. **Preserve existing behaviour** unless this plan changes it. In particular:
   - Promotions: MROUND 0.05 pricing, reverse discount, the Gap column, price-risk flags, paste-from-Excel, multi-code splitting, leading-zero-safe code reading, per-promotion catalogs, Audit view.
   - Delivery: quick-entry keyboard flow, customer memory (last payment/platform), area/phone cleanup, realtime sync, snapshot-diff saving.
7. **UI conventions:** use the in-app `showToast` / `showConfirm` / `showPrompt` dialogs, never native `alert`/`confirm`. Escape all user text with `escapeHtml`. Use the existing CSS tokens (`--pine`, `--brick`, `--gold`, …) and support dark mode.
8. **Commit at the end of each phase** with a clear message. Keep phases reviewable.
9. When something in this plan is ambiguous, ask instead of guessing. Open questions are listed in §11.

---

## 3. Roles and permissions

Roles live in a `profiles` table (Phase 1). Cashiers have **no accounts**; they use a PIN-protected public link (Phase 4).

| Area | admin | accountant | delivery | floor_manager |
|---|---|---|---|---|
| Sell-outs: view, download, export, archive / unarchive | ✅ | ✅ | ❌ | read active only (for floor check) |
| Sell-outs: add, edit, price, activate, duplicate, delete | ✅ | ❌ (owner, 2026-09-29) | ❌ | ❌ |
| Promotions: view, export, download the file | ✅ | ✅ | ❌ | current ones, read only (floor check) |
| Promotions: create, edit rows, import, catalog, archive, delete | ✅ | ❌ (owner, 2026-09-29) | ❌ | ❌ |
| Promotions: AI offer import | ✅ | ❌ | ❌ | ❌ |
| Credit notes | ✅ | ❌ | ❌ | ❌ |
| Vendors (directory, orders) | ✅ | ❌ | ❌ | ❌ |
| Rentals | ✅ | ❌ | ❌ | ❌ |
| Cash differences (enter, edit, summaries) | ✅ | ✅ | ❌ | ❌ |
| Cash months: lock | ✅ | ✅ | ❌ | ❌ |
| Cash months: unlock | ✅ | ❌ | ❌ | ❌ |
| Delivery: orders, customers | ✅ | ❌ | ✅ | ❌ |
| Delivery: driver payments (mark paid) | ✅ | ✅ | ✅ | ❌ |
| Delivery: drivers, reports, settings, backup, restore, wipe | ✅ | ❌ | ❌ | ❌ |
| Floor check (do the check) | ✅ | ❌ | ❌ | ✅ |
| Floor check results and history | ✅ | ❌ | ❌ | own checks |
| Users management | ✅ | ❌ | ❌ | ❌ |
| Activity log (view) | ✅ | ❌ | ❌ | ❌ |

**Delivery order editing rule (decided):**
- Delivery users may **create** orders and **edit orders dated today** (Beirut date).
- They may change `paid` / `paid_at` on **any** order (needed for driver payments).
- Only **admin** may delete orders or edit older orders.

**Login style (decided):** every person gets their **own login**. Staff may not have email addresses, so log in with a **username + password**. Implementation: map the username to a synthetic email like `username@lvajaltoun.local` for Supabase Auth. Users never see that email.

---

## 4. Phase 0: Setup and safety

- [x] `git init`, add both HTML files, first commit "Baseline before rebuild".
- [x] Write `scripts/backup.md` (or a small admin-only in-app button, Phase 1) describing how to export every table to JSON/CSV. **Take a full backup now.**
- [x] Inspect the live schema (tables, columns, existing RLS policies, especially the delivery app's `setup.sql` policies on `dt_*` tables) and write it to `docs/schema-before.md`.
- [x] Fix the main app sidebar footer: it says data is "stored locally in this browser only", which is false. Replace it with the signed-in user's name and role (Phase 1). For now, remove the false sentence.
- [x] Decide the final file layout, e.g.:
  ```
  index.html            (single entry point after merge)
  cashier.html          (public PIN page, Phase 4)
  css/app.css
  js/core/*.js          (supabase client, auth, helpers, dialogs, activity log)
  js/modules/*.js       (sellouts, creditnotes, promotions, vendors, rentals, delivery, cash, floorcheck, users)
  supabase/migrations/*.sql
  supabase/functions/*  (edge functions)
  docs/
  ```

**Done when:** repo exists, backup taken, schema documented, false footer text gone.

---

## 5. Phase 1: Logins, roles, database rules, merged Delivery, activity log

### 5.1 Database

- [x] `profiles` table: `id uuid primary key references auth.users on delete cascade`, `username text unique not null`, `display_name text`, `role text not null check (role in ('admin','accountant','delivery','floor_manager'))`, `active boolean default true`, `created_at timestamptz default now()`.
- [x] SQL helpers (`security definer`, `stable`):
  - `app_role()` → current user's role, or `null` if not signed in or inactive.
  - `is_role(variadic text[])` → boolean.
  - `beirut_today()` → `(now() at time zone 'Asia/Beirut')::date`.
- [ ] **Enable RLS on every table** and write policies matching §3. Remove any existing "open to everyone" policies (check the `dt_*` ones from the delivery app's `setup.sql`). The `anon` role gets **no** access to any table.
- [x] `dt_orders`: add `created_by uuid`, `updated_by uuid`. Enforce the delivery editing rule with a `BEFORE UPDATE` trigger: if the user is not admin and `old.order_date <> beirut_today()`, reject any change except to `paid` and `paid_at`. Deletes: admin only (RLS).
- [x] `activity_log` table: `id bigserial`, `at timestamptz default now()`, `user_id uuid`, `username text`, `role text`, `module text`, `action text`, `entity_type text`, `entity_id text`, `summary text`, `details jsonb`. RLS: any signed-in active user may **insert** only rows with their own `user_id`; only admin may **select**; nobody may update or delete.
- [x] First admin: document how to create it (Supabase dashboard → Auth → add user, then insert the `profiles` row with role `admin`).

### 5.2 Edge function `admin-users`

- Verifies the caller's JWT and that the caller is an active admin.
- Actions: `create` (username, display name, role, temporary password), `update` (display name, role, active), `reset_password`, `disable`.
- Uses the service role key from Supabase secrets, never shipped to the browser.

### 5.3 Frontend

- [x] Login screen: username + password, clear error messages, "signed in as" in the sidebar footer, logout button.
- [x] Session persists across reloads. On load: no session → login screen; inactive profile → message and sign out.
- [x] Role-based navigation: each role sees only its sections (§3). Direct navigation to a hidden section (URL hash) redirects to the role's home.
- [x] Landing page per role: admin → Sell-outs (a home dashboard is parked, §10); accountant → Sell-outs; delivery → Delivery › Orders with the quick-entry row focused; floor_manager → Floor check (placeholder page until Phase 5).
- [x] **Users page** (admin only, under Settings): list users, add, change role, reset password, disable.
- [x] Shared `logActivity(module, action, entity, summary, details)` helper, used everywhere from now on.
- [x] Every Supabase error that is an RLS denial shows a friendly "You don't have permission to do that" toast.

### 5.4 Merge the Delivery app into the main app

- [x] New sidebar section **Delivery** with sub-tabs: Orders, Driver payments, Customers, Drivers, Reports, Settings.
- [x] Port the delivery code as its own module, keeping its data layer (snapshot-diff `sync()`, realtime subscription, `fetchAll` paging) and all its behaviour.
- [x] Restyle it with the main app's design tokens so it looks like one app. Keep the quick-entry row and its layout.
- [x] Keyboard shortcuts (F2/N, 1–6, `/`, arrows, `?`) are active **only while the Delivery section is showing** and must not fire while typing in other modules.
- [x] Hide from delivery users (and block with RLS): Drivers, Reports, Settings, backup/restore, delete-all-data, deleting orders, editing past orders.
- [x] Record `created_by` / `updated_by` on orders; log order create/edit/delete and "marked paid" to `activity_log`.
- [x] Retire the old delivery link: replace `delivery.html` with a page that redirects to the main app (keep the file so old bookmarks still work).

### 5.5 Tests (must all pass)

- Signed out: every table read/write fails.
- Delivery user: can add an order and edit today's order; cannot edit yesterday's order except paid status; cannot delete; cannot read `promotions`, `sellouts`, `vendors`, cash tables.
- Accountant: can open Sell-outs, Promotions, Cash (placeholder), Delivery › Driver payments; cannot open anything else.
- Floor manager: sees only Floor check.
- Admin: sees everything, can manage users, can read the activity log.
- Existing data is all still present and editable by admin.

---

## 6. Phase 2: Sell-outs

### 6.1 Database (`sellouts`, additive)

- `note text`
- `archived boolean default false`, `archived_at timestamptz`, `archived_by uuid`
- `price_column text` (header of the column used as the old price)
- `pricing jsonb`: the last bulk rule applied, e.g. `{ "mode": "percent", "value": 20 }`
- `priced_items jsonb`: one entry per item row, `{ "row": 0, "code": "...", "description": "...", "oldPrice": 3.5, "mode": "percent|amount|fixed|manual", "value": 20, "newPrice": 2.8 }`
- Keep `items` (the raw imported rows) untouched.

### 6.2 Import and pricing

- [x] **No catalog.** The price comes from the imported Excel.
- [x] On import, detect columns: code (first column, as today), description, and price (header aliases: `price`, `sale price`, `saleprice`, `retail`, `old price`, `unit price`, …). Show a small mapping step so the user can correct detected columns before saving.
- [x] Pricing panel on each sell-out with three modes:
  - **Percentage off:** `newPrice = MROUND(oldPrice × (1 − pct/100), 0.05)`
  - **Fixed amount off:** `newPrice = MROUND(oldPrice − amount, 0.05)`
  - **Fixed final price:** `newPrice = value` (rounded to 2 decimals)
- [x] Apply to **all items** or **selected items**; any single row can be overridden by hand (mode `manual`).
- [x] Table columns: Code, Description, Old price, New price, Discount % (computed), Mode.
- [x] Warnings: new price ≥ old price, new price ≤ 0, discount > 25% (same blinking dot style as Promotions), missing old price.
- [x] **Export to Excel:** sell-out name and dates, note, then Code, Description, Old price, New price, Discount %.
- [x] Reuse the existing `mround` / `round2` helpers from Promotions (move them to a shared helpers file).

### 6.3 Note field

- [x] Note in the Add and Edit sell-out forms; shown under the name in the list.

### 6.4 Filters and archiving

- [x] Filters: **All · Needs action · Active · Upcoming · Archived**. Remove "Inactive".
  - Upcoming = not active, not archived, start date in the future.
  - All = everything **not archived**.
- [x] **Archiving is manual only** (it is the accountant's confirmation that the sell-out was removed from the store's system):
  - The Archive button is disabled while the sell-out is active (tooltip: "Deactivate it first").
  - The confirmation text: "Confirm this sell-out has been removed from the system?"
  - Sets `archived`, `archived_at`, `archived_by`; logs to `activity_log`.
  - Unarchive is available from the Archived filter (admin and accountant), and is logged.
- [x] New **"Needs archiving"** flag (gold): end date passed, deactivated, not archived. Include it in the Needs action filter and the sidebar pill count.
- [x] Archived sell-outs never trigger notifications.

### 6.5 Templates (duplicate)

- [x] **Duplicate** button on archived sell-outs (and on active ones for convenience).
- [x] Copies items, `priced_items`, `pricing`, `price_column`, note, and file; name gets " (copy)"; asks for the new From/To dates; resets `active`, `log`, `notified_flags`, `archived`.
- [x] Logged.

### 6.6 Activity log entries

Create, edit, delete, activate, deactivate, apply pricing (with mode and value), manual row override, archive, unarchive, duplicate.

---

## 7. Phase 3: Rentals

> **Replaced by the store map (2026-09-29).** Rentals now live on the store map: see `store-map/WIRING.md`.
> The page has a **Map** view (store-map/store-map.js, admin only) and a **List** view of the same contracts
> (`rental_contracts`, filters by term and spot type, "Show on map" / "Place on map", supplier sales grid with the
> renew / review signal, renewal reminders on the bell). Migrations `012_store_map.sql` (tables, RLS, bucket) and
> `013_migrate_vendor_rentals.sql` (the 46 old rentals → yearly contracts, amount 0, not placed; their monthly
> figures are supplier **sales**, kept in `monthly_sales`). `vendor_rentals` is kept untouched until the owner
> confirms. Gondolas are rentable fixtures and there is a Pillar spot type. The list-only design below is history.
>
> **Changed 2026-09-29 (owner): the List is a recap per supplier.** Migration `016_rentals_recap.sql` empties the
> list (removes the contracts copied by 013; everything is re-assigned on the map; the old sales are not kept)
> and adds `rental_supplier_sales` (performance per supplier). Each supplier's card: their current spots
> ("1 End cap · 1 Gondola"), the total ("$21,000 / year + $250 / month"), ending soon / not billed / not placed,
> the contracts with Show on map, and the monthly sales grid with the renew / review signal. Toggle: Current ·
> All, with ended contracts. The contract's supplier is picked from Vendors.

### 7.1 Database (`vendor_rentals`, additive)

- `rental_term text check in ('yearly','other') default 'other'`
- `equipment_type text check in ('gondola','side_gondola','basket_side','screen_wall','screen_island')`
- `annual_amount numeric` (yearly only)
- `billed boolean default false`, `billed_at date` (yearly only)
- `note text`
- Migrate existing rows to `rental_term = 'other'`, `equipment_type = 'gondola'`. The admin can correct them afterwards.

### 7.2 UI

- [x] Top tabs: **Yearly rentals · Other rentals**.
- [x] **Yearly rentals:** equipment is Gondola or Side gondola; fields: supplier, equipment type, description, contract start, contract end, **one annual amount** (billed once), billed status plus date, note.
  - Comparison with the previous yearly contract for the same supplier and equipment type, with the renew/review signal (reuse `rentalSignal`).
  - **Renewal reminder:** 30 days before the contract end, bell notification (dedupe per rental per day) and an "Ending soon" badge.
  - Totals: this year's contracts, billed vs. not billed.
- [x] **Other rentals:** sub-tabs **Gondola · Basket side · Screens**. Screens show a Wall/Island badge and a Wall/Island filter. Keep the existing monthly grid (previous year and current year) and year totals per tab.
- [x] Add/edit form adapts to the term: yearly shows the annual amount and billed status; other shows the monthly grids.
- [x] Excel import: add optional `Term` and `Type` columns; anything missing defaults to other and gondola.

---

## 8. Phase 4: Cash differences and cashier link

### 8.1 Database

- `cashiers`: `id`, `name`, `active`, `sort_order`, `pin_hash` (bcrypt via `pgcrypto crypt()`), `failed_attempts int default 0`, `locked_until timestamptz`.
- `cash_differences`: `id`, `cashier_id`, `day date`, `amount numeric`, `currency text default 'LBP'`, `note text`, `created_by`, `updated_by`, `updated_at`; unique `(cashier_id, day, currency)`.
- `cash_months`: `month text primary key` ('YYYY-MM'), `locked boolean`, `locked_by`, `locked_at`.
- `cash_settings`: warning threshold, danger threshold, and alert rules (defaults: warning at ±500,000, danger at ±1,000,000; confirm with the owner).
- RLS: admin and accountant only. `anon` has no access; the cashier page goes through the edge function.
- Trigger: reject writes to days in a locked month.

### 8.2 Accountant grid

- [x] Month picker. Rows = days of the month, columns = active cashiers (in `sort_order`), same shape as the current Google Sheet.
- [x] Cells accept numbers only (negative = short, positive = over); saves on blur; paste a block from Excel; Enter moves down, Tab moves right.
- [x] Note icon per cell.
- [x] Cell colours from thresholds (tints matching the current sheet's red shades), consistent everywhere.
- [x] Row and column totals.
- [x] Locked months are read-only with a lock banner. Lock: admin or accountant; unlock: admin only; both logged.
- [x] Manage cashiers (add, rename, reorder, deactivate, set or reset PIN).
- [x] Reminder: if yesterday has no entries by a set hour, show a notification to the accountant.

### 8.3 Analysis (admin and accountant)

- [x] Monthly summary per cashier: total over, total short, net, number of short days, biggest single difference.
- [x] Pattern alerts, for example: 3+ shortages above the warning threshold in a month; short 3 days in a row; monthly net shortage above the danger threshold.
- [x] Trend per cashier across the last 12 months (simple chart).

### 8.4 Import history

- [x] Import the existing monthly sheets: header row contains "Day of the month" plus cashier names; one sheet per month (tab names like `AUG-2026`, `JUL-2026`; ask for the month when the tab is "Current Month").
- [x] Parse numbers stored as text ("249000", "-2500"); treat blanks as no entry; create unknown cashiers after confirmation.
- [x] Show a preview with cells that could not be parsed or that sit outside a cashier column (e.g. a stray value between columns) before importing.

### 8.5 Cashier public page (`cashier.html`)

- [x] No login. The cashier picks their name and enters a **4-digit PIN**.
- [x] Edge function `cashier-view` checks the PIN against `pin_hash` and returns **only that cashier's** differences and notes for the requested month (current and previous months). **Read-only.**
- [x] Lock out after 5 wrong PINs for 15 minutes.
- [x] Shows the month grid for that cashier only, plus a monthly total. No other cashier's data is ever sent to the browser.

---

## 9. Phase 5: Floor check

### 9.1 Database

- `floor_checks`: `id`, `check_date`, `started_by`, `completed_at`, `summary jsonb`.
- `floor_check_items`: `id`, `check_id`, `sellout_id`, `code`, `description`, `expected_price`, `status` in `('pending','ok','wrong_price','missing_tag','out_of_stock')`, `note`, `photo_path`, `checked_at`, `checked_by`, `resolved boolean`, `resolved_by`, `resolved_at`.
- Storage bucket `floor-photos` (private).

### 9.2 Floor manager page (mobile-first)

- [x] "Today's floor check": every item of every sell-out active today, with its **expected price** (the sell-out's new price from Phase 2).
- [x] Items from sell-outs **starting or ending today** come first.
- [x] Large tap buttons per item: ✅ Correct · ❌ Wrong price · 🏷️ Tag missing · 📦 Out of stock. Optional note and photo (camera).
- [x] Progress bar; resumes where he left off if the page is reopened the same day.
- [x] "Finish check" → the admin gets a notification with counts.

### 9.3 Admin view

- [x] List of checks; each shows only the problems. Mark a problem as resolved (logged).
- [x] History: items that repeatedly come back wrong.

Covering active **promotions** as well as sell-outs is an optional extension; ask before adding it.

---

## 10. Phase 6: AI offer import (admin only)

Goal: suppliers send offers as PDFs, photos, or WhatsApp screenshots, usually identifying items by **barcode**. The admin drops in the files and gets a reviewed table, instead of retyping.

> **Changed 2026-09-29 (owner):** the AI part is **not wanted** and was removed after being built
> (the `extract-offer` function, the review screen and the offer-file bucket; migration 009).
> **Kept:** §10.1 catalog barcodes, plus Barcode and Discount columns in "Import price sheet".
> §10.2 and §10.3 below are history only.

### 10.1 Catalog barcodes

- [x] Catalog upload detects a barcode column (aliases: `barcode`, `bar code`, `ean`, `upc`, `gtin`).
- [x] Support several barcodes per item, both as one row per barcode and as several barcodes in one cell separated by `/ , ;` or spaces (the actual format is an open question, §11).
- [x] Store the mapping (e.g. `catalog_barcodes`: `promotion_id`, `barcode`, `code`), or a `barcodes text[]` column on `catalog_items`.
- [x] Keep reading barcodes as text (leading zeros matter), like codes today.

### 10.2 Edge function `extract-offer`

- Verifies the caller is an active admin.
- Accepts up to 10 files (PDF, JPG, PNG, WEBP).
- Calls the Anthropic Messages API. The API key lives in the Supabase secret `ANTHROPIC_API_KEY`, and the model name in `ANTHROPIC_MODEL` so it can be changed without code edits.
- Asks for structured JSON, one object per offer line: `barcode`, `supplier_code`, `description`, `old_price`, `promo_price`, `discount_pct`, `pack_note`, `confidence` (0–1), `source` (file and page).
- Returns the lines; stores nothing itself.
- Logs usage (number of files) to `activity_log`.

### 10.3 Review screen

- [x] Entry point: in a promotion, an **"Import from file or photo"** button (admin only).
- [x] Left: preview of the uploaded file or page; right: an editable table of extracted lines.
- [x] Validate barcodes with the check digit (EAN-13, EAN-8, UPC-A); invalid ones are highlighted as a likely misread.
- [x] Matching order: barcode → item code; else exact code; else the top 3 suggestions by description similarity for the admin to pick.
- [x] Highlight low-confidence lines, invalid barcodes, and unmatched lines; each line can be accepted or skipped.
- [x] **Export to Excel** at any time from the review screen, with columns `Itemcode`, `Barcode`, `Description`, `Old Price`, `Promo Price`, `Discount`, `Cost`, `Check`. It must re-import cleanly through the existing "Import price sheet" (which looks for the `Itemcode` and `Description` headers).
- [x] **Add to promotion:** ask whether to append or replace the table, then reuse the existing price-sheet import logic (catalog lookup, discount rules, flags). Save the source files to the promotion (Supabase Storage).

---

## 10b. Phase 7: Shelf labels and barcode scanning (added 2026-09-29)

Goal: shelf workers scan items that need a new shelf label; the accountant prints the labels from an
Excel file. The same camera scanner helps the floor check find items fast.

Decided with the owner (2026-09-29):
- A new role **`shelf`** ("Shelf worker") with its own username + password, created on the Users page.
  Shelf workers see **only** the Labels page.
- Scanning uses the **phone camera** and must be **very fast**: continuous scanning, a beep/vibration
  on each read, no button press per item. Use the browser's `BarcodeDetector` where it exists (Android
  Chrome) and a scanning library from the CDN where it does not (iPhone Safari).
- **No barcode → item code lookup:** the Excel's `ItemCode` column holds the scanned barcode as-is.
- Barcodes are added to the sell-out and promotion files from now on (owner).

### 10b.1 Database

- [x] `profiles.role` accepts `'shelf'`; §3 gets a Labels row (shelf: scan own lists; accountant +
  admin: see submitted lists, export).
- [x] `label_lists`: `id`, `created_by`, `created_at`, `submitted_at`, `exported_at`, `exported_by`.
- [x] `label_items`: `id`, `list_id`, `barcode text` (leading zeros kept), `qty int`, `scanned_at`;
  unique `(list_id, barcode)`.
- [x] RLS: a shelf worker creates and edits only their own list until it is submitted; accountant and
  admin read submitted lists and mark them exported; nobody else sees them.

### 10b.2 Shelf worker page (phone-first)

- [x] Big **Scan** view: camera opens, every barcode read is added at once (same barcode again = Qty + 1),
  with a beep/vibration and the last items shown under the camera.
- [x] The list: barcode, Qty (+ / − / type a number), remove; can also type a barcode by hand.
- [x] The list is saved as it grows (a closed page loses nothing).
- [x] **Done** submits the list to the accountant and starts a new empty one.

### 10b.3 Accountant (and admin) page

- [x] Submitted lists (who, when, number of items), and one merged total per barcode.
- [x] **Export to Excel**: one sheet with exactly the headers **`ItemCode`** and **`Qty`** (barcodes as
  text so leading zeros survive; quantities summed per barcode across the exported lists).
- [x] After the export the page is **emptied**: the exported lists are marked exported and hidden
  (kept in the database for history; nothing is deleted). Logged.

### 10b.4 Scanning in the floor check

- [x] Sell-out and promotion imports detect a barcode column (aliases as in §10.1) and keep it as text.
- [x] Floor check items store the barcode; a **Scan** button opens the camera and jumps to the scanned
  item (opens its group, highlights it) so it can be marked straight away. Unknown barcode → "Not in
  today's check" message.

---

## 10c. Phase 8: Per-user permissions (added 2026-09-29)

Owner decisions (2026-09-29): permissions **per action**; **roles are starting templates** — the admin can
add or remove single permissions for one user. Admins always have everything; only admins manage users.

- [x] 31 permissions in 11 groups (list in `js/core/permissions.js`, same rows seeded by migration 014; a
  test checks they match). Vendors is one permission ("see and manage"), the rest are split by action,
  e.g. Sell-outs: see · add/edit · set prices · archive · delete; Promotions: see · edit · Audit Type/Note ·
  archive · delete; Cash: see · enter · lock · unlock · cashiers; Delivery: orders · payments · customers ·
  reports · manage; Floor check: do · manage; Labels: scan · print; Rentals: see · contracts · layout.
- [x] Role defaults reproduce §3 exactly (accountant, delivery, floor manager, shelf), so nothing changes until
  the admin edits someone.
- [x] Database: `permissions`, `role_permissions`, `user_permissions` (overrides only), `has_perm(...)`,
  `my_permissions()`; every rule of 005, 006, 010/011, 012, the delivery order trigger and the activity log
  now uses `has_perm`; 002 (lockdown, not applied yet) uses it too, with column guards for sell-outs
  (per column: archive / price / edit) and promotions (Audit may change only Type and Note).
- [x] App: sections, delivery pages and every button follow `can(...)`; the writes refuse what the user may
  not do; before 014 is applied the app falls back to the role defaults.
- [x] Users page: **Permissions** per user (not for admins): grouped checkboxes starting from the role,
  "added" / "removed" marks, Reset to role; ticking an action ticks its group's "see" permission; the list
  shows "+N −N custom". Changes apply the next time that person opens the app. Logged.

---

## 10d. Tools: PDF / photo to Excel (added 2026-09-29)

Owner decisions (2026-09-29): free, in the browser (no AI, nothing uploaded); permission `tools.convert`,
admin only by default (give it per user in Users → Permissions).

- [x] Tools page (`js/modules/tools.js`): choose or drop PDFs / photos (several photos = several pages).
- [x] Digital PDFs: text + positions from pdf.js (exact). Pages with no text layer, photos, and PDFs with
  "Read PDFs as images": OCR with Tesseract.js (English / English + French / Arabic + English), page read as
  one block, photo tilt corrected from the text lines. Libraries from jsDelivr, loaded on first use.
- [x] Rows and columns rebuilt from word positions (lines → cells → columns where cells line up; a
  right-aligned column's heading is joined to its numbers; two full columns such as Debit / Credit stay apart).
- [x] Preview: edit any cell, remove a row / column, join a row to the one above; OCR words the reader was
  unsure of are highlighted; "Rotate & re-read" for sideways photos.
- [x] Download .xlsx: pages in one sheet (the title / header repeated on each page kept once) or one sheet per
  page; **every cell is text**, formatted as Text in Excel (owner, 2026-09-29: no 5.454E+4, no lost zeros).
  Copy (tab-separated) for pasting into Excel. Converting and downloading are logged.

---

## 10e. Brand, installable app, notifications (added 2026-09-30)

- [x] La Valeur logo as the icon of the whole app (browser tab, home screen / desktop app, login, sidebar):
  `icons/` built from the logo by `scripts/make-icons.mjs` (192, 512, maskable 512, Apple 180, favicon 32,
  white badge 96). Colours: the logo blue `#1943AF` replaces the old blue everywhere (sidebar in the logo blue),
  light and dark mode.
- [x] Installable (PWA): `manifest.webmanifest` + `sw.js` (network first for the app's own files, offline start;
  Supabase data never cached). "Install app" in the bell panel (browser prompt; iPhone: Share → Add to Home Screen).
- [x] Notifications: every bell alert (sell-outs, vendors, rentals, floor check, cash, delivery) also shows on the
  phone / computer when the app is in the background, through the service worker (needed on phones); turned on
  per device from the bell panel's footer. iPhone: only once the app is installed (iOS 16.4+).
- [x] Stays signed in on the device (owner, 2026-09-30): "Keep me signed in on this device" (default on) keeps the
  session in localStorage plus a backup of the refresh token (long-lived cookie + IndexedDB) that signs back in if
  the phone wiped localStorage; a missing connection at launch shows "Connecting…" and retries instead of the
  sign-in form; storage asked to be persistent. Unticked: sessionStorage (signed out when the browser closes).
  Sign out removes everything.
- [x] Notifications while the app is closed (Web Push, owner 2026-09-30): migration `017_web_push.sql`
  (push_subscriptions via register_push / unregister_push, push_log, perms_of, pg_cron every 10 min → the
  `push-alerts` edge function). The function builds the bell's alerts on the server (sell-outs, vendor orders,
  cash day missing, floor check finished, rental contracts ending at 30/14/7/3/1/0 days, labels sent for
  printing) and pushes each once to each person whose permissions cover it; quiet hours 22:00–07:00 Beirut.
  Web Push is encrypted and signed with WebCrypto only (`push-alerts/webpush.js`, checked against http_ece).
  Keys: `scripts/make-push-keys.mjs` → .env; secrets for the CLI and Vault in `supabase/secrets/` (git-ignored).
  Devices register when notifications are turned on and after sign-in; sign-out unregisters the device.
- [x] Targeted alerts (owner, 2026-09-30), each to whoever holds the permission (admin gets all):
  floor managers (floorcheck.do): sell-out switched ON (check the new prices) and switched OFF (check the prices
  are back to normal); accountant: label list sent (labels.print), sell-out needs action (sellouts.view) and needs
  archiving (sellouts.archive), promotion starting tomorrow with its item count (promotions.view; empty one →
  promotions.edit); admin: yesterday's delivery day closed with count, value and unpaid (delivery.manage /
  reports), a spot rented by someone else, rent ending (30/14/7/3/1/0 days) and rent expired yesterday;
  promo ladies (promoladies.manage): the day before one starts and the morning she starts.
  More than 3 new alerts for one person in one run → one digest notification. While the app is in front, a push
  goes into the bell instead (the bell skips exact repeats).

---

## 10f. Promo ladies (added 2026-09-30)

- [x] Section "Promo ladies" (`js/modules/promoladies.js`, migration `018_promo_ladies.sql`), permission
  `promoladies.manage`: admin and floor manager by default. A booking: supplier (from Vendors, searchable; warns on
  other names), Paid / Free, amount in USD when paid (required), item promoted, from / to dates, note.
- [x] Calendar tab: month grid (Monday first), paid / free chips per day, the selected day's list with Edit and
  "+ Add on this day"; month total of bookings and paid amount. Phone: counts per day, the day's list below.
- [x] List tab: now and upcoming / past / all, search, totals (paid amount, free, in the store today), status.
- [x] Every add / edit / delete is logged.

---

## 11. Open questions (ask the owner when you reach the phase)

| # | Question | Default until answered |
|---|---|---|
| 1 | Are "side gondola" (yearly) and "basket side" (other) the same equipment? | **Answered 2026-09-29:** different. Gondola, side gondola, basket side and pillar can each be yearly or monthly; screens are monthly only |
| 2 | Cash differences: LBP only, or USD too? | **Changed 2026-09-29: LBP.** (First answer was USD only.) Migration 015 put every amount back to its original LBP value (all rows came from the LBP sheets) and converted the levels at 89,500 (895,000 / 1,790,000 LBP); the grid, analysis, import and cashier page are in LBP, whole pounds. Grid columns: past months show only cashiers with entries; the current month also shows active cashiers, with a banner to mark inactive those with no entries this month (from the 8th) |
| 3 | Cash colour thresholds | **Answered 2026-09-29:** ±$10 warning, ±$20 danger (editable in Cash settings) |
| 4 | How does the catalog export list multiple barcodes per item? | Support both formats |
| 5 | Does the catalog export already include a barcode column? | Owner, 2026-09-29: barcodes will be added to the sell-out and promotion files from now on. Catalog: detect a barcode column when present |
| 6 | Should the floor check include active promotions? | **Answered 2026-09-29:** yes. Promotions running today (not archived, today within their dates) are checked against their promo price; the floor manager can read those promotions and their rows only |
| 7 | Credit notes access for the accountant? | Admin only |

---

## 12. Parked ideas (do not build unless asked)

Per-role home dashboards, exports in the POS/ERP import format, automatic code fixing by description, learning Audit type choices per supplier, price-sheet change comparison on re-import, stock-out prediction before promos, auto-drafted vendor orders sent to the salesman on WhatsApp, on-account customer balances and statements, driver cash handover check, calendar view, barcode scanning on the floor, credit note amounts and aging, moving base64 files out of tables into Supabase Storage.

---

## 13. Definition of done (every phase)

- Works signed in as each role, and fails correctly signed in as the wrong role (test with RLS, not just the UI).
- No console errors; works on phone width; dark mode is correct.
- Existing data is still intact.
- New actions are written to `activity_log`.
- SQL migrations are committed and documented; the phase is committed to git.
- A short summary is given to the owner: what changed, what to test, and any SQL that must be run.
