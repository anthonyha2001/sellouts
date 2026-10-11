-- 081 — Floor check › Today: groups checked, and the record of who placed every label (owner, 2026-10-11).
--   floor_ref_checks : one row per (day, promotion / sell-out, reason, group): the floor manager marked that group
--                      checked (every label of the group is placed correctly). Who and when.
--   floor_ref_done   : one row when EVERY group of a promotion / sell-out is checked: the admin is told once
--                      (push-alerts) and it stays as the record.
--   floor_ref_check_group(group, sources) / floor_ref_uncheck_group(group, sources): the two actions.
-- Additive only: two tables and two functions.

create table if not exists public.floor_ref_checks (
  id uuid primary key default gen_random_uuid(),
  check_date date not null,
  source_kind text not null,            -- 'promotion' | 'sellout'
  source_id text not null,
  source_name text,
  reason text not null,                 -- starts | ends | price_changed | running
  group_name text not null,             -- Group > Sub-group (or 'No group')
  items integer not null default 0,
  checked_by uuid references auth.users on delete set null,
  checked_by_name text,
  checked_at timestamptz not null default now(),
  unique (check_date, source_kind, source_id, reason, group_name)
);
create index if not exists floor_ref_checks_day on public.floor_ref_checks (check_date);

create table if not exists public.floor_ref_done (
  id uuid primary key default gen_random_uuid(),
  check_date date not null,
  source_kind text not null,
  source_id text not null,
  source_name text,
  reason text not null,
  groups integer not null default 0,
  items integer not null default 0,
  completed_by uuid references auth.users on delete set null,
  completed_by_name text,
  completed_at timestamptz not null default now(),
  unique (check_date, source_kind, source_id, reason)
);

alter table public.floor_ref_checks enable row level security;
alter table public.floor_ref_done enable row level security;
drop policy if exists floor_ref_checks_read on public.floor_ref_checks;
create policy floor_ref_checks_read on public.floor_ref_checks for select to authenticated
  using (public.has_perm('floorcheck.do', 'floorcheck.manage'));
drop policy if exists floor_ref_done_read on public.floor_ref_done;
create policy floor_ref_done_read on public.floor_ref_done for select to authenticated
  using (public.has_perm('floorcheck.do', 'floorcheck.manage'));

-- p_sources: [{ kind, id, name, reason, items, groups_total }]. Returns the sources completed by this action
-- (every group of the source is now checked): [{ name, reason, groups, items }].
create or replace function public.floor_ref_check_group(p_group text, p_sources jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s jsonb; me text; day date := (now() at time zone 'Asia/Beirut')::date;
        done jsonb := '[]'::jsonb; n integer; total integer; items_sum integer;
begin
  if not public.has_perm('floorcheck.do', 'floorcheck.manage') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select coalesce(nullif(display_name, ''), username) into me from public.profiles where id = auth.uid();
  for s in select * from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) loop
    insert into public.floor_ref_checks (check_date, source_kind, source_id, source_name, reason, group_name, items, checked_by, checked_by_name)
    values (day, s ->> 'kind', s ->> 'id', s ->> 'name', coalesce(s ->> 'reason', 'running'), coalesce(nullif(trim(p_group), ''), 'No group'),
            coalesce((s ->> 'items')::int, 0), auth.uid(), me)
    on conflict (check_date, source_kind, source_id, reason, group_name) do nothing;
    total := coalesce((s ->> 'groups_total')::int, 1);
    select count(*), coalesce(sum(items), 0) into n, items_sum from public.floor_ref_checks
     where check_date = day and source_kind = s ->> 'kind' and source_id = s ->> 'id' and reason = coalesce(s ->> 'reason', 'running');
    if n >= total and not exists (select 1 from public.floor_ref_done d where d.check_date = day and d.source_kind = s ->> 'kind'
                                   and d.source_id = s ->> 'id' and d.reason = coalesce(s ->> 'reason', 'running')) then
      insert into public.floor_ref_done (check_date, source_kind, source_id, source_name, reason, groups, items, completed_by, completed_by_name)
      values (day, s ->> 'kind', s ->> 'id', s ->> 'name', coalesce(s ->> 'reason', 'running'), n, items_sum, auth.uid(), me);
      done := done || jsonb_build_array(jsonb_build_object('name', s ->> 'name', 'reason', coalesce(s ->> 'reason', 'running'), 'groups', n, 'items', items_sum));
    end if;
  end loop;
  return done;
end $$;
revoke execute on function public.floor_ref_check_group(text, jsonb) from public, anon;
grant execute on function public.floor_ref_check_group(text, jsonb) to authenticated;

-- undo a group's check (the one who made it, or a floor check manager); the "done" record stays
create or replace function public.floor_ref_uncheck_group(p_group text, p_sources jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare s jsonb; day date := (now() at time zone 'Asia/Beirut')::date; n integer := 0; c integer;
begin
  if not public.has_perm('floorcheck.do', 'floorcheck.manage') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  for s in select * from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) loop
    delete from public.floor_ref_checks
     where check_date = day and source_kind = s ->> 'kind' and source_id = s ->> 'id' and reason = coalesce(s ->> 'reason', 'running')
       and group_name = coalesce(nullif(trim(p_group), ''), 'No group')
       and (checked_by = auth.uid() or public.has_perm('floorcheck.manage'));
    get diagnostics c = row_count; n := n + c;
  end loop;
  return n;
end $$;
revoke execute on function public.floor_ref_uncheck_group(text, jsonb) from public, anon;
grant execute on function public.floor_ref_uncheck_group(text, jsonb) to authenticated;
