# Store Map — wiring guide

This folder is a finished, tested **store map module** for the Rentals section: viewer, layout editor and rental contracts, with the ground floor already traced from the PDF plan. It runs on its own (`demo.html`) with browser storage. Wiring it into the app means swapping that storage for Supabase, which is what this guide covers.

> For Claude Code: read this whole file, then `CLAUDE.md`. This module **replaces** the list-only design in CLAUDE.md §7 (Phase 3 — Rentals). Update §7 to point here. Do not rewrite the module; wire it. If something needs changing inside it, change it in place and keep the demo working.

---

## 1. What's in the folder

| File | What it is |
|---|---|
| `store-map.js` | The module (`StoreMap.mount`). Vanilla JS, no dependencies, ~1,300 lines. |
| `store-map.css` | Its styles. Uses the main app's tokens (`--paper`, `--ink`, `--pine`, …) with fallbacks; light and dark mode. |
| `seed-ground-floor.js` | The ground floor, traced from `ajaltoun Ground floor.pdf`: 5 grocery aisles, the breakfast/beverage block, bakery/healthy/sweets block, island freezer, wall fridges, displays, promo tables, spirits corner, checkouts. Used once to fill the database. |
| `local-adapter.js` | Browser-storage data layer, used by the demo. |
| `supabase-adapter.js` | The real data layer. Same methods as the local one. Written against `schema.sql` but **not yet run against the live database**: test each method once. |
| `schema.sql` | Tables, RLS (admin only), Storage bucket for tracing images, and the `rental_charges` view. |
| `demo.html` | Standalone demo with sample contracts (fake amounts) so every status colour shows. |

The **Mezzanine** is not traced yet (only the ground floor PDF was provided). It is added as an empty floor; the owner draws it in Edit layout, over a tracing image of its plan.

---

## 2. Wiring steps

1. **Run `schema.sql`** in Supabase (after Phase 1, since it uses `app_role()`). Show the owner the SQL first, as per CLAUDE.md.
2. **Copy the files** into the app, e.g. `js/modules/store-map/` and `css/store-map.css`, and load them in `index.html`:
   ```html
   <link rel="stylesheet" href="css/store-map.css">
   <script src="js/modules/store-map/seed-ground-floor.js"></script>
   <script src="js/modules/store-map/supabase-adapter.js"></script>
   <script src="js/modules/store-map/store-map.js"></script>
   ```
3. **Add a "Map" view to the Rentals section** (next to the existing list views), with a container such as `<div id="rentalsMap"></div>`.
4. **Mount it once**, the first time the Rentals section is opened:
   ```js
   const adapter = StoreMapSupabaseAdapter(sb, { userName: profile.display_name, bucket: 'store-maps' });
   await adapter.seedIfEmpty(window.STORE_MAP_SEED, [{ id: 'mezzanine', name: 'Mezzanine', width: 3000, height: 2000, sort: 2 }]);
   const storeMap = StoreMap.mount(document.getElementById('rentalsMap'), {
     adapter,
     canEdit: profile.role === 'admin',
     canManageRentals: profile.role === 'admin',
     currency: '$',
     today: () => beirutToday(),                  // the app's local-date helper
     toast: (msg, isError) => showToast(msg, isError),
     confirm: (msg, okLabel) => showConfirm(msg, okLabel),
     onActivity: (action, summary, details) => logActivity('rentals', action, { type: 'rental' }, summary, details)
   });
   ```
   The map re-fits itself automatically the first time its container becomes visible. Call `storeMap.refresh()` after anything outside the map changes rentals data.
5. **Migrate existing rentals** (`vendor_rentals`) into `rental_contracts`, **unplaced** (`spot_id = null`), with `legacy_rental_id` and `legacy_label` (supplier + gondola description) filled. They appear in the map panel under "Contracts not placed on the map", each with a **Place** button: the admin clicks it, then clicks the right spot. Mapping rules:
   - yearly rentals → `term = 'yearly'`, `amount = annual_amount`, dates from the contract dates.
   - monthly-grid rentals → `term = 'monthly'`; if the monthly amounts differ, create one contract per run of equal months (show the owner the plan before running it).
   - never delete `vendor_rentals`; keep it until the owner confirms the migration.
6. **Keep the list views** (Yearly / Other with Gondola · Basket side · Screens tabs) but read them from `rental_contracts` joined to `store_map_objects` (spot type → tab). Clicking a row calls `storeMap.focusSpot(spotId)` and switches to the Map view.
7. **Renewal reminders:** reuse the app's notification bell. Once a day, for every contract where `end_date - today` is 30 days or less and no later contract exists on the same spot, push "Contract for {supplier} on {spot} ends {date}". Dedupe per contract per day (same pattern as sell-outs).
8. **Test** with an admin and a non-admin account (non-admin must get nothing: RLS), on desktop and phone width, light and dark mode.

---

## 3. Adapter contract

Every method is `async`. Objects use the camelCase shapes below; the Supabase adapter maps them to snake_case columns.

| Method | Returns / does |
|---|---|
| `loadConfig()` | `{ types, cats }` or `null` (use defaults) |
| `saveConfig({ types, cats })` | save edited element types and department colours |
| `listFloors()` | `[{ id, name, width, height, sort, trace? }]` |
| `saveFloor(floor)` | create or update; uploads a new tracing image to Storage |
| `listObjects(floorId)` | the floor's elements |
| `saveLayout(floorId, objects, { note })` | replace the floor's layout, and store a version snapshot |
| `listLayoutVersions(floorId)` | `[{ id, createdAt, note, by }]` |
| `restoreLayoutVersion(id)` | the objects of that version (loaded into the editor, not saved until Save) |
| `listContracts()` / `saveContract(c)` / `deleteContract(id)` | rental contracts |
| `seedIfEmpty(seeds, extraFloors)` | Supabase only: one-time import of the traced plan |

**Map object**
```js
{ id, type, x, y, w, h, rot,          // map units; rot in degrees, around the element's centre
  label, occupant,                    // occupant = supplier physically there (shown when no contract)
  sectionsA: [{ label, size, cat }],  // gondolas/shelves: side A sections (size = relative length)
  sectionsB: [...] }                  // side B (double-sided gondolas)
```

**Contract**
```js
{ id, spotId, supplier, term: 'yearly' | 'monthly', start, end,   // dates 'YYYY-MM-DD'
  amount,                              // yearly: whole year · monthly: per month
  billed, billedAt, paid, paidAt, note, legacyLabel }
```

**Spot status** (computed, never stored), in this priority order: *ending* (active, ends within 30 days, no follow-up contract) → *unbilled* (active, not billed) → *rented* → *upcoming* (only a future contract) → *expired* (last contract ended, not renewed) → *no contract* (occupant written on the map, no contract) → *free*.

---

## 4. What the module already does

- **Standard sizes:** every gondola is 600 × 110 with identical end columns (side 80 × 25 · end cap 80 × 60 · side 80 × 25); basket sides 50 × 80, displays 110 × 110, display sides 110 × 25, fridge doors 60 × 80, promo tables 160 × 40. The seed is laid out on an even grid (aisles 100 wide). In Edit layout, **Standard size** snaps the selected element (or everything on the floor) back to its standard, and **Types** lets the owner change the standard sizes.
- **Icons:** each department has its own SVG icon (`ICONS` in store-map.js), drawn next to every section name, in the legend and in the side panel. Each spot type has one too (star = end cap, basket, display stand, screen, snowflake = fridge, tag = promo table, megaphone = promo zone). A department or type can use another icon by setting `icon: '<name>'` in its config.
- **Look:** tiled floor, shelving units with a department-coloured shelf-edge rail on each aisle side, 1 m bay lines and a metal spine; glass-door fridges and an iced island freezer; rounded display pedestals, basket-mesh basket sides, screens with a dark bezel, checkout counters with a belt, an entrance marker; numbered aisle pills and large zone names (all editable). Light and dark mode.
- **Two floors** (tabs), zoom (wheel, pinch, buttons), pan (drag), fit to screen; phone and desktop.
- **Rentals view:** every rentable spot coloured by status, with a legend and filter chips (with counts) plus a spot-type filter. **Categories view:** gondolas coloured by department.
- **Search** a supplier or category: matches highlight, counts per floor, results list; Enter zooms to them.
- **Spot panel:** current contract, time left, billed/paid, history; actions: rent, edit, renew (pre-filled next period), mark billed, mark paid, end today, delete.
- **Overview panel:** occupancy, rental income this year vs last year, and lists for ending soon, expired, not billed, occupied without contract, free spots (each with a "by Frying oil"-style location hint), and contracts not placed on the map.
- **Edit layout (admin):** add any element type, drag to move, handles to resize, rotate, duplicate, delete, arrow-key nudge, snap to grid, undo/redo, properties panel, section editor per gondola side (name, relative length, department, reorder), editable element types (rename, rentable on/off, add new types), tracing image upload with opacity, add floors, layout history with restore. Nothing is saved until **Save layout**, with an optional note.
- **Export:** print the floor, PNG, SVG, contracts CSV.
- **Safety:** warns on overlapping contracts for one spot; deleting a spot with live contracts asks first and keeps the contracts (they become "not placed"); unsaved layout changes warn before leaving.

## 5. Known gaps (for later)

- The Mezzanine still has to be drawn (needs its plan).
- The PNG/SVG export leaves out the tracing image.
- Multi-select (moving several elements at once) is not supported yet; duplicate + arrow keys cover most cases.
- Rental income assumes one currency.
