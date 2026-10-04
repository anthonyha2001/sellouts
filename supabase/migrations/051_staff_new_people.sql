-- 051 — New people on the Staff page (owner, 2026-10-04), linked to their app login when they have one.
--   Warehouse worker: Shaoun, Shozib, Suhag
--   Fruits & vegetables: Ozir, Sehab, Arif, Walid
--   Parking: Mustafa, Charbel
--   Purchasing: Anthony Hasrouny (login anthony.hasrouny), Charles
--   Accountant: Maria, Elsy Abi Rizk (login elsy), Marinelle Medawar (login marinelle)
--   HR: Carla Stephan (login carla)
--   Data entry: Leticia
-- Also links two people already on the list to their login: Clarita Seif (clarita), Sherif (sherif).
-- ADDITIVE (rows added; nothing changed or removed except those two links). Skips anyone already there.

insert into public.staff (name, job, user_id, sort_order)
select v.name, v.job, p.id, (select coalesce(max(sort_order), 0) from public.staff) + v.n
  from (values
    (1, 'Shaoun', 'Warehouse worker', null), (2, 'Shozib', 'Warehouse worker', null), (3, 'Suhag', 'Warehouse worker', null),
    (4, 'Ozir', 'Fruits & vegetables', null), (5, 'Sehab', 'Fruits & vegetables', null), (6, 'Arif', 'Fruits & vegetables', null), (7, 'Walid', 'Fruits & vegetables', null),
    (8, 'Mustafa', 'Parking', null), (9, 'Charbel', 'Parking', null),
    (10, 'Anthony Hasrouny', 'Purchasing', 'anthony.hasrouny'), (11, 'Charles', 'Purchasing', null),
    (12, 'Maria', 'Accountant', null), (13, 'Elsy Abi Rizk', 'Accountant', 'elsy'), (14, 'Marinelle Medawar', 'Accountant', 'marinelle'),
    (15, 'Carla Stephan', 'HR', 'carla'),
    (16, 'Leticia', 'Data entry', null)
  ) as v(n, name, job, login)
  left join public.profiles p on p.username = v.login
 where not exists (select 1 from public.staff s where lower(trim(s.name)) = lower(v.name));

update public.staff s set user_id = p.id, updated_at = now()
  from public.profiles p
 where s.user_id is null and not exists (select 1 from public.staff x where x.user_id = p.id)
   and ((lower(s.name) = 'clarita seif' and p.username = 'clarita') or (lower(s.name) = 'sherif' and p.username = 'sherif'));
