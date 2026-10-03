-- 044 — Drag and drop to reorder staff (owner, 2026-10-04), same as the Staff schedule everywhere.
--   staff_reorder(ids): the people dragged take the places (sort_order values) they already had between
--     them, in the new order — the rest of the list keeps its places. For the Staff page (staff.manage) and
--     the Staff schedule (schedule.manage / schedule.edit; any department).
--   schedule_staff() (043): cashiers and cashier supervisors keep the Cash page order (cashiers list);
--     everyone else (pickers too) follows the Staff list order, so dragging them sticks.
-- ADDITIVE (new function; schedule_staff replaced, same columns).

create or replace function public.staff_reorder(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare slots int[];
begin
  if not public.has_perm('staff.manage', 'schedule.manage', 'schedule.edit') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select array_agg(sort_order order by sort_order) into slots from public.staff where id = any(p_ids);
  update public.staff s set sort_order = slots[o.n], updated_at = now()
    from unnest(p_ids) with ordinality as o(id, n)
   where s.id = o.id and s.sort_order is distinct from slots[o.n];
  -- Equal places (e.g. never ordered): spread them out after the smallest one.
  if (select count(distinct x) from unnest(slots) x) < array_length(slots, 1) then
    update public.staff s set sort_order = slots[1] + o.n - 1
      from unnest(p_ids) with ordinality as o(id, n) where s.id = o.id;
    update public.staff set sort_order = sort_order + array_length(slots, 1)
     where not (id = any(p_ids)) and sort_order >= slots[1];
  end if;
end $$;
revoke execute on function public.staff_reorder(uuid[]) from public, anon;
grant execute on function public.staff_reorder(uuid[]) to authenticated;

create or replace function public.schedule_staff()
returns table (key text, staff_id uuid, cashier_id uuid, name text, job text, active boolean, sort_order integer,
               pos text, default_station text, has_pin boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_perm('schedule.manage', 'schedule.edit') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
    select coalesce(s.cashier_id, s.id)::text, s.id, s.cashier_id, s.name, s.job, s.active,
           case when c.position in ('cashier', 'supervisor') then c.sort_order else 100000 + s.sort_order end,
           c.position, c.default_station, coalesce(c.has_pin, false)
      from public.staff s left join public.cashiers c on c.id = s.cashier_id
     order by 7, s.name;
end $$;
