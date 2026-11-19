-- 105 — Supervisors cannot change the supervisors' shifts (owner, 2026-11-19): theirs or another
-- supervisor's. Only HR (schedule.manage) and admin set them. Supervisors keep editing the cashiers.
--   schedule_weeks_guard: an app user without schedule.manage (schedule.edit) may not change the row of
--     anyone who is a supervisor on the cashiers list. A new week they create may only carry a supervisor's
--     row as it was the week before (Copy last week) or empty.
--   schedule_set_cell (cashier page draft, through cashier-view): refuses a supervisor's cell.
-- ADDITIVE (functions replaced, same signatures and grants; trigger unchanged).

-- A day list compared as 7 cells ('' when missing): an empty row and no row are the same.
create or replace function public.schedule_row_same(a jsonb, b jsonb) returns boolean
language sql immutable as $$
  select bool_and(coalesce(a ->> d, '') = coalesce(b ->> d, '')) from generate_series(0, 6) d
$$;

create or replace function public.schedule_weeks_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  k text; d int; a text; b text; cur public.schedule_changes; det jsonb; nm text; who text; prev jsonb;
  days text[] := array['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
begin
  if auth.uid() is null or public.has_perm('schedule.manage') then return new; end if;   -- HR and server jobs: free
  -- schedule.edit: may not publish / unpublish
  if tg_op = 'INSERT' then
    if new.published then raise exception 'Only HR can publish a week' using errcode = '42501'; end if;
    -- supervisors' rows (migration 105): empty, or as they were the week before
    select assignments into prev from public.schedule_weeks where week_start = new.week_start - 7;
    for k in select id::text from public.cashiers where position = 'supervisor' loop
      if not public.schedule_row_same(new.assignments -> k, '[]'::jsonb)
         and not public.schedule_row_same(new.assignments -> k, prev -> k) then
        raise exception 'Only HR can set the supervisors'' shifts' using errcode = '42501';
      end if;
    end loop;
    return new;
  end if;
  if new.published is distinct from old.published then raise exception 'Only HR can publish or unpublish a week' using errcode = '42501'; end if;
  -- supervisors' rows (migration 105): unchanged
  for k in select id::text from public.cashiers where position = 'supervisor' loop
    if not public.schedule_row_same(new.assignments -> k, old.assignments -> k) then
      raise exception 'Only HR can change the supervisors'' shifts' using errcode = '42501';
    end if;
  end loop;
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

-- The supervisors' draft on the cashier page: a supervisor's cell is HR's (same function as 104 otherwise).
create or replace function public.schedule_set_cell(p_week date, p_staff uuid, p_day int, p_code text, p_editor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb; d jsonb; i int;
  seg constant text := '((am|pm)(:(front|back))?|full(:(front|back)(/(front|back))?)?)(\|[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9])?';
begin
  if p_day < 0 or p_day > 6 then raise exception 'Bad day'; end if;
  if exists (select 1 from public.cashiers where id = p_staff and position = 'supervisor') then
    raise exception 'Only HR can change the supervisors'' shifts' using errcode = '42501';
  end if;
  if p_code !~ ('^(|off|' || seg || '(;' || seg || '){0,3})$') then raise exception 'Bad shift'; end if;
  select assignments into a from public.schedule_weeks where week_start = p_week and not published for update;
  if not found then raise exception 'This week is published or does not exist' using errcode = '42501'; end if;
  d := coalesce(a -> p_staff::text, '[]'::jsonb);
  for i in jsonb_array_length(d) .. 6 loop d := d || '""'::jsonb; end loop;
  d := jsonb_set(d, array[p_day::text], to_jsonb(p_code));
  update public.schedule_weeks
     set assignments = jsonb_set(coalesce(a, '{}'::jsonb), array[p_staff::text], d), last_editor = p_editor
   where week_start = p_week;
  return d;
end $$;
revoke all on function public.schedule_set_cell(date, uuid, int, text, text) from public, anon, authenticated;
grant execute on function public.schedule_set_cell(date, uuid, int, text, text) to service_role;
