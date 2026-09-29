-- ============================================================
-- Store map + rental contracts — Supabase schema
-- Run AFTER Phase 1 (it uses app_role() from the logins/roles migration).
-- Additive only: creates new tables, never touches existing ones.
-- ============================================================

-- Floors (Ground floor, Mezzanine, …)
create table if not exists store_floors (
  id          text primary key,
  name        text not null,
  width       integer not null default 3000,
  height      integer not null default 2000,
  sort        integer not null default 0,
  trace       jsonb,               -- tracing image: { path, x, y, w, h, opacity, visible } (image itself in Storage)
  updated_at  timestamptz not null default now()
);

-- Every element drawn on a floor: gondolas, shelves, end caps, displays, screens, checkouts…
create table if not exists store_map_objects (
  id          text primary key,
  floor_id    text not null references store_floors(id) on delete cascade,
  type        text not null,       -- key from store_map_config.types (gondola, endcap, screen_wall, …)
  x           numeric not null,
  y           numeric not null,
  w           numeric not null,
  h           numeric not null,
  rot         numeric not null default 0,
  label       text,
  occupant    text,                -- supplier physically there (used when there is no contract yet)
  sections_a  jsonb,               -- [{ label, size, cat }] side A of a gondola / shelf
  sections_b  jsonb,               -- side B
  props       jsonb,               -- room for future per-element settings
  sort        integer not null default 0,
  updated_at  timestamptz not null default now()
);
create index if not exists store_map_objects_floor_idx on store_map_objects(floor_id);

-- A snapshot every time a layout is saved, so any earlier layout can be restored
create table if not exists store_layout_versions (
  id               bigserial primary key,
  floor_id         text not null,
  objects          jsonb not null,
  note             text,
  created_by       uuid default auth.uid(),
  created_by_name  text,
  created_at       timestamptz not null default now()
);
create index if not exists store_layout_versions_floor_idx on store_layout_versions(floor_id, created_at desc);

-- Editable element types and department colours (one row)
create table if not exists store_map_config (
  id          text primary key default 'singleton',
  types       jsonb,
  cats        jsonb,
  updated_at  timestamptz not null default now()
);

-- Rental contracts. spot_id is deliberately NOT a foreign key: if a spot is deleted from the
-- map, its contracts must survive and show up as "not placed on the map" until re-placed.
create table if not exists rental_contracts (
  id                text primary key,
  spot_id           text,
  supplier          text not null,
  term              text not null check (term in ('yearly','monthly')),
  start_date        date not null,
  end_date          date not null check (end_date >= start_date),
  amount            numeric not null default 0,  -- yearly: total for the year · monthly: per month
  billed            boolean not null default false,
  billed_at         date,
  paid              boolean not null default false,
  paid_at           date,
  note              text,
  legacy_rental_id  text,                        -- vendor_rentals.id this contract was migrated from
  legacy_label      text,                        -- e.g. "Gondola + freezer cap", to help place it on the map
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists rental_contracts_spot_idx on rental_contracts(spot_id);
create index if not exists rental_contracts_dates_idx on rental_contracts(end_date);

-- ------------------------------------------------------------
-- Row level security: admin only (CLAUDE.md §3 — Rentals: admin)
-- ------------------------------------------------------------
alter table store_floors          enable row level security;
alter table store_map_objects     enable row level security;
alter table store_layout_versions enable row level security;
alter table store_map_config      enable row level security;
alter table rental_contracts      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['store_floors','store_map_objects','store_layout_versions','store_map_config','rental_contracts'] loop
    execute format('drop policy if exists %I on %I', t || '_admin_all', t);
    execute format('create policy %I on %I for all to authenticated using (app_role() = ''admin'') with check (app_role() = ''admin'')', t || '_admin_all', t);
  end loop;
end $$;

-- Layout history is append-only: nobody edits or deletes old versions
drop policy if exists store_layout_versions_admin_all on store_layout_versions;
create policy store_layout_versions_read   on store_layout_versions for select to authenticated using (app_role() = 'admin');
create policy store_layout_versions_insert on store_layout_versions for insert to authenticated with check (app_role() = 'admin');

-- ------------------------------------------------------------
-- Storage bucket for tracing images (private)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('store-maps', 'store-maps', false)
on conflict (id) do nothing;

drop policy if exists store_maps_admin on storage.objects;
create policy store_maps_admin on storage.objects for all to authenticated
  using (bucket_id = 'store-maps' and app_role() = 'admin')
  with check (bucket_id = 'store-maps' and app_role() = 'admin');

-- ------------------------------------------------------------
-- Automatic billing: one row per charge, generated from contracts
-- (yearly → one charge on the start date; monthly → one per month)
-- ------------------------------------------------------------
create or replace view rental_charges as
select c.id as contract_id, c.spot_id, c.supplier, c.term,
       c.start_date as due_date, c.amount, c.billed, c.paid
from rental_contracts c where c.term = 'yearly'
union all
select c.id, c.spot_id, c.supplier, c.term,
       gs::date as due_date, c.amount, null::boolean, null::boolean
from rental_contracts c,
     generate_series(date_trunc('month', c.start_date), date_trunc('month', c.end_date), interval '1 month') gs
where c.term = 'monthly';
-- The view inherits the RLS of rental_contracts when queried with security_invoker:
alter view rental_charges set (security_invoker = true);
