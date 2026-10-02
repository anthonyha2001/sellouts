-- 034 — Online promotion page (owner, 2026-10-02): the items of the online-only sell-outs (032), for the
-- delivery team (and the accountant); they are told by push when a sell-out is marked online.
-- ADDITIVE.

insert into public.permissions (key, grp, label, sort)
values ('sellouts.online', 'Sell-outs', 'Online promotion page (online-only sell-out items); told when one starts', 3)
on conflict (key) do nothing;

insert into public.role_permissions (role, perm) values ('delivery', 'sellouts.online'), ('accountant', 'sellouts.online')
on conflict do nothing;

-- They read the online-only sell-outs (nothing else, no writing).
drop policy if exists sellouts_online_read on public.sellouts;
create policy sellouts_online_read on public.sellouts for select to authenticated
  using (online and public.has_perm('sellouts.online'));
