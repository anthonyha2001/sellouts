-- 031 — Supervisors with an app login edit the schedule; HR is told what they changed (owner, 2026-10-02).
--   schedule.edit   : fill drafts AND change published weeks, "Send to HR" — but not publish / unpublish,
--                     not the staff list or PINs.
--   schedule.manage : HR, as before (everything).
-- A change by a schedule.edit user to a PUBLISHED week is collected in schedule_changes (per person and
-- day: what it was, what it is now); the push-alerts function tells HR once the editing has stopped.
-- ADDITIVE.

insert into public.permissions (key, grp, label, sort)
values ('schedule.edit', 'Staff schedule', 'Edit the schedule (drafts and published weeks); HR is told about changes to published weeks', 36)
on conflict (key) do nothing;

-- Weeks: both can read and write; only HR deletes. Publishing is checked by the trigger below.
drop policy if exists schedule_weeks_all on public.schedule_weeks;
drop policy if exists schedule_weeks_read on public.schedule_weeks;
drop policy if exists schedule_weeks_insert on public.schedule_weeks;
drop policy if exists schedule_weeks_update on public.schedule_weeks;
drop policy if exists schedule_weeks_delete on public.schedule_weeks;
create policy schedule_weeks_read   on public.schedule_weeks for select to authenticated using (public.has_perm('schedule.manage', 'schedule.edit'));
create policy schedule_weeks_insert on public.schedule_weeks for insert to authenticated with check (public.has_perm('schedule.manage', 'schedule.edit'));
create policy schedule_weeks_update on public.schedule_weeks for update to authenticated using (public.has_perm('schedule.manage', 'schedule.edit')) with check (public.has_perm('schedule.manage', 'schedule.edit'));
create policy schedule_weeks_delete on public.schedule_weeks for delete to authenticated using (public.has_perm('schedule.manage'));

-- The staff list and the requests are needed to edit (read only for schedule.edit).
drop policy if exists cashiers_read on public.cashiers;
create policy cashiers_read on public.cashiers for select to authenticated
  using (public.has_perm('cash.view', 'cash.cashiers', 'cash.enter', 'schedule.manage', 'schedule.edit'));
drop policy if exists schedule_requests_read on public.schedule_requests;
create policy schedule_requests_read on public.schedule_requests for select to authenticated
  using (public.has_perm('schedule.manage', 'schedule.edit'));

-- What supervisors changed on published weeks. One open row per person and week until HR has been told
-- (notified_at); details = { "<staff id>:<day>": { "name", "day", "from", "to" } } (from = before their first edit).
create table if not exists public.schedule_changes (
  id          bigserial primary key,
  week_start  date not null,
  changed_by  uuid,
  by_name     text,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  notified_at timestamptz
);
create index if not exists schedule_changes_week on public.schedule_changes (week_start, updated_at desc);
alter table public.schedule_changes enable row level security;
revoke all on public.schedule_changes from anon, authenticated;
grant select on public.schedule_changes to authenticated;
drop policy if exists schedule_changes_read on public.schedule_changes;
create policy schedule_changes_read on public.schedule_changes for select to authenticated
  using (public.has_perm('schedule.manage', 'schedule.edit'));

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
          select name into nm from public.cashiers where id::text = k;
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
drop trigger if exists schedule_weeks_guard on public.schedule_weeks;
create trigger schedule_weeks_guard before insert or update on public.schedule_weeks
  for each row execute function public.schedule_weeks_guard();

-- Live updates on the Staff schedule page (migration 021).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'schedule_changes') then
    alter publication supabase_realtime add table public.schedule_changes;
  end if;
end $$;

-- Clarita Seif (supervisor, account "clarita"): edit, not manage (owner, 2026-10-02).
delete from public.user_permissions where perm = 'schedule.manage'
  and user_id = (select id from public.profiles where username = 'clarita');
insert into public.user_permissions (user_id, perm, allowed)
select id, 'schedule.edit', true from public.profiles where username = 'clarita'
on conflict do nothing;
