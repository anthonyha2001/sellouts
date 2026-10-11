-- 079 — Shelf labels: printing follows the permission, not the role (owner, 2026-10-11).
-- A floor manager (or anyone) given "labels.print" must be able to open the lists sent for printing, edit them
-- and export them. 010 / 011 decided this by ROLE (admin, accountant); 014 and 026 moved it to permissions.
-- This file puts the permission-based rules back in place, in one go, whatever state the database is in:
-- safe to run again (functions are replaced, policies dropped and created). No data is touched.

-- who may see a list's items / change them
create or replace function public.label_list_editable(p_list uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.label_lists l
                 where l.id = p_list
                   and (   (l.created_by = auth.uid() and l.submitted_at is null and public.has_perm('labels.scan'))
                        or (l.submitted_at is not null and l.exported_at is null and public.has_perm('labels.print'))))
$$;
create or replace function public.label_list_visible(p_list uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.label_lists l
                 where l.id = p_list
                   and ((l.created_by = auth.uid() and public.has_perm('labels.scan'))
                        or (l.submitted_at is not null and public.has_perm('labels.print'))))
$$;
revoke execute on function public.label_list_editable(uuid) from public, anon;
revoke execute on function public.label_list_visible(uuid) from public, anon;
grant execute on function public.label_list_editable(uuid) to authenticated;
grant execute on function public.label_list_visible(uuid) to authenticated;

-- the guard: exporting needs labels.print (not a role)
create or replace function public.label_lists_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  new.created_by := old.created_by; new.created_at := old.created_at;
  if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
    raise exception 'A submitted list cannot be reopened' using errcode = '42501';
  end if;
  if new.exported_at is distinct from old.exported_at then
    if not public.has_perm('labels.print') then
      raise exception 'You are not allowed to export labels' using errcode = '42501';
    end if;
    if new.submitted_at is null then
      raise exception 'Only submitted lists can be exported' using errcode = '42501';
    end if;
    new.exported_by := case when new.exported_at is null then null else auth.uid() end;
  else
    new.exported_by := old.exported_by;
  end if;
  return new;
end $$;
drop trigger if exists label_lists_guard on public.label_lists;
create trigger label_lists_guard before update on public.label_lists
  for each row execute function public.label_lists_guard();

-- the lists: own list with labels.scan; submitted lists with labels.print
drop policy if exists label_lists_select on public.label_lists;
create policy label_lists_select on public.label_lists for select to authenticated
  using ((created_by = auth.uid() and public.has_perm('labels.scan'))
         or (submitted_at is not null and public.has_perm('labels.print')));
drop policy if exists label_lists_insert on public.label_lists;
create policy label_lists_insert on public.label_lists for insert to authenticated
  with check (public.has_perm('labels.scan') and created_by = auth.uid() and submitted_at is null and exported_at is null);
drop policy if exists label_lists_update on public.label_lists;
create policy label_lists_update on public.label_lists for update to authenticated
  using ((created_by = auth.uid() and submitted_at is null and public.has_perm('labels.scan'))
         or (submitted_at is not null and public.has_perm('labels.print')))
  with check (created_by = auth.uid() or public.has_perm('labels.print'));

-- the items follow their list
drop policy if exists label_items_select on public.label_items;
create policy label_items_select on public.label_items for select to authenticated
  using (public.label_list_visible(list_id));
drop policy if exists label_items_insert on public.label_items;
create policy label_items_insert on public.label_items for insert to authenticated
  with check (public.label_list_editable(list_id));
drop policy if exists label_items_update on public.label_items;
create policy label_items_update on public.label_items for update to authenticated
  using (public.label_list_editable(list_id)) with check (public.label_list_editable(list_id));
drop policy if exists label_items_delete on public.label_items;
create policy label_items_delete on public.label_items for delete to authenticated
  using (public.label_list_editable(list_id));

-- a person given labels.print may also see who made the list (names on the page)
-- (the function above is security definer, so nothing else is needed)
