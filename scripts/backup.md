# Backups

Take a full backup **before every phase that changes the database schema** (PLAN.md §2 rule 1).

## Data backup (every table → JSON + CSV)

Requires Node 18+ (no packages to install).

```sh
node --env-file=.env scripts/backup.mjs
```

Writes `backups/<YYYY-MM-DD-HH-MM Beirut time>/` with one `<table>.json` (lossless, used for restores) and one
`<table>.csv` (opens in Excel) per table, plus `_summary.json`. The script pages through large tables
and compares its row count with the server's count; it exits with an error if anything is missing.

`backups/` is in `.gitignore` because it holds customer data. Copy important backups somewhere safe
(OneDrive already syncs this folder, and Drive or a USB stick are good extra copies).

### Which key

The script reads `SUPABASE_SECRET_KEY` from `.env` in the project folder. `.env` is git-ignored, so the key
never goes into git or into a page. The secret key bypasses RLS, which keeps backups complete after Phase 1.
Without `.env` it falls back to the publishable key, and after Phase 1 that reads nothing.

New tables added in later phases: add them to `TABLES` in `backup.mjs`, or pass
`EXTRA_TABLES=cashiers,cash_differences node scripts/backup.mjs`.

## Schema backup

The data backup does not include table definitions, policies, triggers or functions.
- Supabase dashboard → Database → Backups: daily backups on paid plans (check your plan).
- Or run `docs/inspect-schema.sql` in the SQL Editor and save the output next to the data backup.

## Restoring

Restores are done table by table with an upsert of the JSON rows, **only after checking with the owner**.
Never wipe a table to restore it; upsert by `id` so that newer rows are kept.

## Backup log

| Date (Beirut) | Folder | Notes |
|---|---|---|
| 2026-09-29 07:21 | `backups/2026-09-29-07-21` | Re-run with the secret key; same counts, plus `dt_staff` (0) |
| 2026-09-29 00:52 | `backups/2026-09-29-00-52` | Phase 0 baseline. All 14 tables complete (dt_customers 1847, promotion_rows 472, catalog_items 420, vendors 170, vendor_orders 145, vendor_rentals 46, dt_orders 41, vendor_skips 19, credit_notes 15, sellouts 8, promotions 3, dt_drivers 2, dt_settings 1, app_settings 0) |
