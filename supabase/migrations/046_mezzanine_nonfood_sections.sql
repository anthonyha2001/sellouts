-- 046 — Mezzanine (non food): the gondola and wall sections from the owner's plan, with the non-food
-- departments (store-map.js DEFAULT_CATS: babycare, paper, femcare, beauty, bath, haircare, deodorant,
-- oralcare, laundry, homecare, detergents, cleaningtools) — owner, 2026-10-04.
-- A gondola's side A is its top side on the plan (sections run left -> right; on a wall turned ~180°
-- they are listed right -> left so they read left -> right on the map).
-- NOTHING IS LOST: the Mezzanine layout as it was is saved first as a layout version ("Before the
-- non-food plan"), restorable from the map (Edit layout > History).

-- 1. Backup: the floor as it is now, in the app's layout format.
insert into public.store_layout_versions (floor_id, objects, note, created_by_name)
select 'mezzanine',
       jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
         'id', o.id, 'type', o.type, 'x', o.x, 'y', o.y, 'w', o.w, 'h', o.h, 'rot', o.rot,
         'label', o.label, 'occupant', o.occupant, 'sectionsA', o.sections_a, 'sectionsB', o.sections_b, 'props', o.props)) order by o.sort),
       'Before the non-food plan (migration 046)', 'Claude'
  from public.store_map_objects o where o.floor_id = 'mezzanine';

-- 2. The sections.
create temp table nf (id text primary key, a jsonb, b jsonb) on commit drop;
insert into nf values
  -- left column, top -> bottom
  ('obj-mus46d1f-yypfg', '[{"label":"Wipes","size":1,"cat":"babycare"},{"label":"Baby shampoo","size":1,"cat":"babycare"},{"label":"Loofas","size":1,"cat":"bath"}]',
                         '[{"label":"Tissues + interfolds","size":2,"cat":"paper"},{"label":"Cartoon tissues","size":1,"cat":"paper"}]'),
  ('obj-mus46mar-q7nmv', '[{"label":"Feminine pads","size":1,"cat":"femcare"},{"label":"Adult diapers","size":1,"cat":"femcare"}]',
                         '[{"label":"Beauty accessories","size":1,"cat":"beauty"},{"label":"Blades","size":1,"cat":"beauty"},{"label":"Shaving foam","size":1,"cat":"beauty"}]'),
  ('obj-mus46s6b-t2dnt', '[{"label":"Nail","size":1,"cat":"beauty"},{"label":"Cotton","size":1,"cat":"beauty"},{"label":"Acetone","size":1,"cat":"beauty"}]',
                         '[{"label":"Hand soap","size":1,"cat":"bath"}]'),
  ('obj-mus46z6b-jzelu', '[{"label":"Softener","size":1,"cat":"laundry"}]',
                         '[{"label":"Insecticides","size":1,"cat":"homecare"},{"label":"Air fresheners","size":1,"cat":"homecare"}]'),
  ('obj-mus477yb-9kbvp', '[{"label":"Aluminium foil + cling film + trash bags","size":1,"cat":"homecare"}]',
                         '[{"label":"Floor detergents","size":1,"cat":"detergents"}]'),
  ('obj-mus47bir-x5s5w', '[{"label":"Surface cleaner","size":1,"cat":"detergents"}]',
                         '[{"label":"WC blocks","size":1,"cat":"detergents"},{"label":"Javel","size":1,"cat":"detergents"}]'),
  ('obj-mus47ga3-ydvwt', '[{"label":"Dishwash","size":1,"cat":"detergents"}]',
                         '[{"label":"Sponges","size":1,"cat":"cleaningtools"}]'),
  -- right column, top -> bottom
  ('obj-mus47zhu-5y1ro', '[{"label":"Hair care","size":1,"cat":"haircare"},{"label":"Cream","size":1,"cat":"haircare"}]',
                         '[{"label":"Shower gel","size":1,"cat":"bath"}]'),
  ('obj-mus47vh7-u2tw4', '[{"label":"Shower gel","size":1,"cat":"bath"}]',
                         '[{"label":"Deodorant men","size":1,"cat":"deodorant"}]'),
  ('obj-mus47mdn-lty5g', '[{"label":"Deodorant men","size":1,"cat":"deodorant"}]',
                         '[{"label":"Toothpaste","size":1,"cat":"oralcare"}]'),
  -- walls
  ('obj-mus4bhr7-qevv1', '[{"label":"Diapers","size":1,"cat":"babycare"}]', null),
  ('obj-mus4bxuz-kl3bi', '[{"label":"Shampoo","size":1,"cat":"haircare"},{"label":"Hair coloring","size":2,"cat":"haircare"}]', null),   -- W2, turned 177°
  ('obj-mus4d4oj-4e75b', '[{"label":"Shampoo","size":1,"cat":"haircare"}]', null),                                                       -- W1
  ('obj-mus4ae0z-1k2ks', '[{"label":"Toilet paper","size":1,"cat":"paper"}]', null),                                                     -- W4
  ('obj-mus493xe-xb7cf', '[{"label":"Laundry gel","size":1,"cat":"laundry"}]', null),                                                    -- W5 top
  ('obj-mus5o1lo-layxe', '[{"label":"Laundry powder","size":1,"cat":"laundry"}]', null),                                                 -- W5 bottom
  ('obj-mus4896i-61oxb', '[{"label":"Gloves","size":1,"cat":"cleaningtools"},{"label":"Cleaning tools","size":1,"cat":"cleaningtools"}]', null),  -- W6, turned 175°
  ('obj-mus4f8vh-f8alf', '[{"label":"Toothbrush","size":1,"cat":"oralcare"}]', null),                                                    -- the hooks under the toothpaste
  ('obj-mus4ert7-7y7jz', '[{"label":"Listerine","size":1,"cat":"oralcare"}]', null);                                                     -- next to the toothpaste

update public.store_map_objects o
   set sections_a = nf.a, sections_b = coalesce(nf.b, o.sections_b), updated_at = now()
  from nf where o.id = nf.id and o.floor_id = 'mezzanine';
