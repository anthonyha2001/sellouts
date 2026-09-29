-- 011: fix "new row violates row-level security policy" when a shelf worker / admin starts a label list.
-- The app inserts the list and reads it back (insert ... returning). The select policy looked the list up
-- by id through label_list_visible(), which cannot see the row being inserted, so the read-back was refused
-- and no scan ever reached the database. The policy now checks the row's own columns (same rule).

drop policy if exists label_lists_select on public.label_lists;
create policy label_lists_select on public.label_lists for select to authenticated
  using ((created_by = auth.uid() and public.is_role('shelf', 'admin'))
         or (submitted_at is not null and public.is_role('admin', 'accountant')));
