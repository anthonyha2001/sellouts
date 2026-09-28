# File layout (decided in Phase 0)

```
index.html              single entry point after the merge: markup shell + <script>/<link> tags only
delivery.html           becomes a redirect to index.html#delivery (Phase 1), kept for old bookmarks
cashier.html            public PIN page (Phase 4)
css/app.css             design tokens (--pine, --brick, --gold, …), light + dark
js/core/
  config.js             SUPABASE_URL + publishable key, createClient → window.sb
  helpers.js            escapeHtml, round2, mround, dates (beirutToday), Excel/code helpers
  dialogs.js            showToast, showConfirm, showPrompt, permission-denied toast
  auth.js               login screen, session, profile/role, logout
  activity.js           logActivity(module, action, entity, summary, details)
  router.js             sidebar, hash routes, role → allowed sections / home page
js/modules/
  sellouts.js  creditnotes.js  promotions.js  vendors.js  rentals.js
  delivery.js  cash.js  floorcheck.js  users.js
supabase/migrations/NNN_description.sql   numbered, additive, run only after approval
supabase/functions/<name>/index.ts         admin-users, cashier-view, extract-offer
scripts/                backup.mjs + backup.md (dev tools; never loaded by the app)
docs/                   schema-before.md, inspect-schema.sql, this file
backups/                git-ignored data backups
```

## Rules

- **Classic `<script>` tags, not ES modules.** They load in a fixed order (core → modules) and share one global scope,
  the same as today's single file, and they keep working when a page is opened straight from disk (`file://`), where
  `type="module"` fails. Each module exposes one namespace object (e.g. `window.Delivery = {…}`) and keeps its
  internals inside a function scope to avoid name clashes, because both apps currently define `sb`, `db`, `escapeHtml`, and so on.
- CDN libraries stay pinned: `xlsx@0.18.5`, `@supabase/supabase-js@2`.
- The split happens during Phase 1, starting with the code Phase 1 touches (core + delivery merge). Other modules move
  out of `index.html` as their phase comes up, so each phase diff stays reviewable.
