-- 043 — The staff schedule takes its people from the Staff list only (owner, 2026-10-03): everyone, grouped by
-- department in the app. A person's key in schedule_weeks.assignments stays what it was: their cashiers-list id
-- for cashiers / cashier supervisors / pickers (so every existing week, the cashier page and the supervisors'
-- draft keep working), their staff id for everyone else. Nothing is moved or deleted.
--   schedule_staff(): the Staff list for the schedule (no salary, phone or note), with the cashier details the
--     schedule needs (usual station, PIN set) — for schedule.manage / schedule.edit.
--   schedule_weeks_guard() (031): changes to a published week name non-cashier staff too.
-- ADDITIVE (new function; the guard function replaced with the same rules).

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
           coalesce(c.sort_order, 100000 + s.sort_order), c.position, c.default_station, coalesce(c.has_pin, false)
      from public.staff s left join public.cashiers c on c.id = s.cashier_id
     order by 7, s.name;
end $$;
revoke execute on function public.schedule_staff() from public, anon;
grant execute on function public.schedule_staff() to authenticated;

create or replace function public.schedule_weeks_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  k text; d int; a text; b text; cur public.schedule_changes; det jsonb; nm text; who text;
  days text[] := array['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
begin
  if auth.uid() is null or public.has_perm('schedule.manage') then return new; end if;   -- HR and server jobs: free
  -- schedule.edit: may not publish / unpublish
  if tg_op = 'INSERT' then
    if new.published then raise exception 'Only HR can publish a week' using errcode = '42501'; end if;
    return new;
  end if;
  if new.published is distinct from old.published then raise exception 'Only HR can publish or unpublish a week' using errcode = '42501'; end if;
  -- a published week changed: collect what changed for HR
  if old.published and new.assignments is distinct from old.assignments then
    select coalesce(display_name, username) into who from public.profiles where id = auth.uid();
    select * into cur from public.schedule_changes
     where week_start = new.week_start and changed_by = auth.uid() and notified_at is null
     order by id desc limit 1 for update;
    det := coalesce(cur.details, '{}'::jsonb);
    for k in select jsonb_object_keys(coalesce(old.assignments, '{}'::jsonb)) union select jsonb_object_keys(coalesce(new.assignments, '{}'::jsonb)) loop
      for d in 0..6 loop
        a := coalesce(old.assignments -> k ->> d, '');
        b := coalesce(new.assignments -> k ->> d, '');
        if a is distinct from b then
          -- a cashier (cashiers list) or anyone else on the Staff page (migration 043)
          select coalesce((select name from public.cashiers where id::text = k), (select name from public.staff where id::text = k)) into nm;
          if det ? (k || ':' || d) then
            det := jsonb_set(det, array[k || ':' || d, 'to'], to_jsonb(b));
          else
            det := det || jsonb_build_object(k || ':' || d, jsonb_build_object('name', coalesce(nm, '?'), 'day', days[d + 1], 'dayIndex', d, 'from', a, 'to', b));
          end if;
          -- changed back to what it was: nothing to report for that cell
          if det -> (k || ':' || d) ->> 'from' = b then det := det - (k || ':' || d); end if;
        end if;
      end loop;
    end loop;
    if cur.id is null then
      if det <> '{}'::jsonb then
        insert into public.schedule_changes (week_start, changed_by, by_name, details) values (new.week_start, auth.uid(), who, det);
      end if;
    elsif det = '{}'::jsonb then
      delete from public.schedule_changes where id = cur.id;
    else
      update public.schedule_changes set details = det, updated_at = now(), by_name = who where id = cur.id;
    end if;
  end if;
  return new;
end $$;
