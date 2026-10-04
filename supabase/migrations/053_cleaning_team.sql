-- 053 — Cleaning team (owner, 2026-10-04): Shozib and Jason — two more people (not the warehouse worker
-- Shozib nor the cashier Jason, who stay where they are). No app login.
-- ADDITIVE (two rows).
insert into public.staff (name, job, sort_order)
select v.name, 'Cleaning', (select coalesce(max(sort_order), 0) from public.staff) + v.n
  from (values (1, 'Shozib'), (2, 'Jason')) as v(n, name)
 where not exists (select 1 from public.staff s where lower(trim(s.name)) = lower(v.name) and s.job = 'Cleaning');
