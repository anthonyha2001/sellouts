-- 012 — Store map + rental contracts (store-map/WIRING.md; replaces the list-only Rentals of PLAN §7).
-- Based on store-map/schema.sql, adapted to this project: public. schema, is_role() for the checks,
-- anon closed, plus `monthly_sales` on contracts (owner, 2026-09-29: the monthly figures of the old
-- rentals are the supplier's sales, used for the renew / review signal, not rent).
-- ADDITIVE ONLY: new tables, a view and a private Storage bucket. vendor_rentals is not touched.

-- Floors (Ground floor, Mezzanine, …)
create table if not exists public.store_floors (
  id          text primary key,
  name        text not null,
  width       integer not null default 3000,
  height      integer not null default 2000,
  sort        integer not null default 0,
  trace       jsonb,               -- tracing image: { path, x, y, w, h, opacity, visible } (image in Storage)
  updated_at  timestamptz not null default now()
);

-- Every element drawn on a floor: gondolas, shelves, end caps, displays, screens, checkouts…
create table if not exists public.store_map_objects (
  id          text primary key,
  floor_id    text not null references public.store_floors(id) on delete cascade,
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
  props       jsonb,
  sort        integer not null default 0,
  updated_at  timestamptz not null default now()
);
create index if not exists store_map_objects_floor_idx on public.store_map_objects(floor_id);

-- A snapshot every time a layout is saved, so any earlier layout can be restored (append-only).
create table if not exists public.store_layout_versions (
  id               bigserial primary key,
  floor_id         text not null,
  objects          jsonb not null,
  note             text,
  created_by       uuid default auth.uid(),
  created_by_name  text,
  created_at       timestamptz not null default now()
);
create index if not exists store_layout_versions_floor_idx on public.store_layout_versions(floor_id, created_at desc);

-- Editable element types and department colours (one row)
create table if not exists public.store_map_config (
  id          text primary key default 'singleton',
  types       jsonb,
  cats        jsonb,
  updated_at  timestamptz not null default now()
);

-- Rental contracts. spot_id is deliberately NOT a foreign key: if a spot is deleted from the
-- map, its contracts survive and show up as "not placed on the map" until re-placed.
create table if not exists public.rental_contracts (
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
  monthly_sales     jsonb,                       -- {"2026-07": 20801, …}: the supplier's sales, for renew / review
  legacy_rental_id  text,                        -- vendor_rentals.id this contract was migrated from
  legacy_label      text,                        -- e.g. "1 gondola + 2 sides", to help place it on the map
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists rental_contracts_spot_idx on public.rental_contracts(spot_id);
create index if not exists rental_contracts_dates_idx on public.rental_contracts(end_date);
create unique index if not exists rental_contracts_legacy_idx on public.rental_contracts(legacy_rental_id) where legacy_rental_id is not null;

-- ------------------------------------------------------------
-- Row level security: admin only (PLAN §3 — Rentals: admin)
-- ------------------------------------------------------------
revoke all on public.store_floors, public.store_map_objects, public.store_layout_versions,
              public.store_map_config, public.rental_contracts from anon;
revoke all on sequence public.store_layout_versions_id_seq from anon;
revoke truncate, references, trigger on public.store_floors, public.store_map_objects, public.store_layout_versions,
              public.store_map_config, public.rental_contracts from authenticated;

alter table public.store_floors          enable row level security;
alter table public.store_map_objects     enable row level security;
alter table public.store_layout_versions enable row level security;
alter table public.store_map_config      enable row level security;
alter table public.rental_contracts      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['store_floors','store_map_objects','store_map_config','rental_contracts'] loop
    execute format('drop policy if exists %I on public.%I', t || '_admin_all', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.is_role(''admin'')) with check (public.is_role(''admin''))', t || '_admin_all', t);
  end loop;
end $$;

-- Layout history is append-only: nobody edits or deletes old versions.
drop policy if exists store_layout_versions_read on public.store_layout_versions;
drop policy if exists store_layout_versions_insert on public.store_layout_versions;
create policy store_layout_versions_read   on public.store_layout_versions for select to authenticated using (public.is_role('admin'));
create policy store_layout_versions_insert on public.store_layout_versions for insert to authenticated with check (public.is_role('admin'));

-- ------------------------------------------------------------
-- Storage bucket for tracing images (private, admin only)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('store-maps', 'store-maps', false)
on conflict (id) do nothing;

drop policy if exists store_maps_admin on storage.objects;
create policy store_maps_admin on storage.objects for all to authenticated
  using (bucket_id = 'store-maps' and public.is_role('admin'))
  with check (bucket_id = 'store-maps' and public.is_role('admin'));

-- ------------------------------------------------------------
-- Charges generated from contracts (yearly → one on the start date; monthly → one per month).
-- security_invoker: the view is read with the caller's rights, so the admin-only RLS applies.
-- ------------------------------------------------------------
create or replace view public.rental_charges with (security_invoker = true) as
select c.id as contract_id, c.spot_id, c.supplier, c.term,
       c.start_date as due_date, c.amount, c.billed, c.paid
from public.rental_contracts c where c.term = 'yearly'
union all
select c.id, c.spot_id, c.supplier, c.term,
       gs::date as due_date, c.amount, null::boolean, null::boolean
from public.rental_contracts c,
     generate_series(date_trunc('month', c.start_date), date_trunc('month', c.end_date), interval '1 month') gs
where c.term = 'monthly';
revoke all on public.rental_charges from anon;
