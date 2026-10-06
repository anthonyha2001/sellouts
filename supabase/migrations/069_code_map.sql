-- 069 — Codes across years (owner, 2026-10-06).
--   The system numbers its items AND its suppliers per year: a year's sales and purchases only know that year's
--   codes (Abboud trading: 0768 in 2025, 1134 in 2026; Taanayel labneh 400g: 016580 in 2025, 128420 in 2026),
--   while the app uses today's codes. code_map links each past-year code to today's code(s): items by barcode,
--   suppliers by name. lv-dashboard ('code_map_build') fills it once per past year; every request reaching into
--   a past year goes through it. A code with no match gets nothing for that year (never another item's figures).
-- ADDITIVE (one table; read and written by lv-dashboard only, with the service key).
create table if not exists public.code_map (
  year           integer not null,
  kind           text    not null check (kind in ('item', 'supplier')),
  code           text    not null,              -- the code in that year
  current_codes  text[]  not null default '{}', -- today's code(s); empty = not found
  barcode        text,
  name           text,
  how            text,                          -- 'barcode', 'barcode (search)', 'name'
  built_at       timestamptz not null default now(),
  primary key (year, kind, code)
);
create index if not exists code_map_current on public.code_map using gin (current_codes);
create index if not exists code_map_year_kind on public.code_map (year, kind);
alter table public.code_map enable row level security;   -- no policy: only the service key (lv-dashboard)
