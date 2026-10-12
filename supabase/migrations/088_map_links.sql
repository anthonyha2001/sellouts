-- 088 — The store map linked to the system's categories (owner, 2026-10-12): each labelled part of a shelf (per side) or a whole
--   counter / area of the map is linked to one or more system categories, so the map shows the sales of what it holds.
--   The system reuses its codes (group JUI is under 4 sections, sub-group codes repeat), so a link keeps the whole path
--   (department > section > group > sub-group), never a code alone.
--   sys_categories: the system's tree as it sells (lv-dashboard cat_tree, from a year of sales), for the picker and suggestions.
--   map_links: object_id + side ('A' / 'B', '' for a whole object) + part_label (the label on the map, '' for a whole object).
--   A part renamed on the map loses its link (it shows as not linked) - never another part's figures.
-- Additive only: two new tables.
create table if not exists public.sys_categories (
  dep text not null default '', dep_desc text,
  sec text not null default '', sec_desc text,
  grp text not null default '', grp_desc text,
  sub text not null default '', sub_desc text,
  sales_12m numeric,
  updated_at timestamptz not null default now(),
  primary key (dep, sec, grp, sub)
);
-- the same path exists under several departments (144 of them: milk under Beverages, Dry food and Self service): the key has the department
alter table public.sys_categories drop constraint if exists sys_categories_pkey;
alter table public.sys_categories add primary key (dep, sec, grp, sub);
alter table public.sys_categories enable row level security;
drop policy if exists sys_categories_read on public.sys_categories;
create policy sys_categories_read on public.sys_categories for select to authenticated using (true);

create table if not exists public.map_links (
  id uuid primary key default gen_random_uuid(),
  object_id text not null,
  side text not null default '',
  part_label text not null default '',
  level text not null check (level in ('department', 'section', 'group', 'subgroup')),
  dep text not null default '',
  sec text not null default '',
  grp text not null default '',
  sub text not null default '',
  name text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists map_links_one on public.map_links (object_id, side, part_label, level, dep, sec, grp, sub);
create index if not exists map_links_obj on public.map_links (object_id);
alter table public.map_links enable row level security;
drop policy if exists map_links_read on public.map_links;
create policy map_links_read on public.map_links for select to authenticated using (public.has_perm('rentals.map') or public.has_perm('rentals.view') or public.has_perm('vendors.manage'));
drop policy if exists map_links_write on public.map_links;
create policy map_links_write on public.map_links for all to authenticated using (public.has_perm('rentals.layout') or public.has_perm('vendors.manage')) with check (public.has_perm('rentals.layout') or public.has_perm('vendors.manage'));
