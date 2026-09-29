# Phase 1 rollout (do these in order)

The order matters: migration 002 switches off anonymous access, so the old pages stop working the
moment it runs. The new app (with login) must be online first.

| # | Step | Who | Status |
|---|---|---|---|
| 1 | Migration 001 (profiles, roles, activity log, order rule) | owner ran it | ✅ 2026-09-29 |
| 2 | First admin `anthony.hasrouny` (sign in with the lavaleur.net email) | owner ran it | ✅ 2026-09-29 |
| 3 | Put the new files online, replacing the old ones: `index.html`, `delivery.html`, `css/`, `js/` | owner | |
| 4 | Deploy the `admin-users` function (see `docs/edge-functions.md`) | owner | |
| 5 | Sign in as admin and check: every section opens; Delivery → Orders, Driver payments work; Users page shows no "read-only" notice | owner | |
| 6 | Create the staff accounts on the Users page | owner | |
| 7 | Backup: `node --env-file=.env scripts/backup.mjs` | Claude | |
| 8 | Approve and apply migration 002 (lockdown) | owner approves | |
| 9 | Re-check as each role (5.5 tests); confirm a signed-out visitor sees nothing | both | |

## What to test after step 8

- Signed out: the login screen; nothing else loads.
- Delivery user: lands on Delivery → Orders with the cursor in the quick-entry row; can add an order and
  edit today's orders; on older orders only the Paid/Unpaid button works; no delete buttons; no other sections.
- Accountant: Sell-outs, Promotions, Cash (placeholder), Delivery → Driver payments only.
- Floor manager: Floor check (placeholder) only.
- Admin: everything, plus Users and Activity log (entries appear for sign-ins and delivery changes).

## Rolling back

- Frontend: put the previous `index.html` / `delivery.html` back (git tag/commit `936bd7e`).
- 002: the old policies are saved in `public._policy_backup_20260929`; re-creating them restores open access.
