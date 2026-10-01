-- 026 — The accountant (labels.print) can correct a sent label list before exporting it
-- (owner, 2026-10-01: Edit button on each list). Until now only the shelf worker could change
-- their own list, and only before sending it. Exported lists stay locked for everyone.
-- ADDITIVE (replaces the helper used by the label_items policies; the policies are unchanged).

create or replace function public.label_list_editable(p_list uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.label_lists l
                 where l.id = p_list
                   and (   (l.created_by = auth.uid() and l.submitted_at is null and public.has_perm('labels.scan'))
                        or (l.submitted_at is not null and l.exported_at is null and public.has_perm('labels.print'))))
$$;
