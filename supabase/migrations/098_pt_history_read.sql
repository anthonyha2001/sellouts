-- 098 — Returns history (owner, 2026-10-20): the Returns page shows who changed a PT's status / note and when, read from
--   the activity log. The data-entry agent and the senior accountant hold vendors.manage, not activity.view, so let them read
--   the PT entries of the log (only those) — the rest of the log still needs activity.view.
-- Additive only: widens the read policy.
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select to authenticated
  using (
    public.has_perm('activity.view')
    or (entity_type = 'pt' and public.has_perm('vendors.manage'))
  );
