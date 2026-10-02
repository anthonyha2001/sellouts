-- 033 — The accountant turns sell-outs on / off (owner, 2026-10-02).
-- New permission sellouts.activate (Turn on / off), given to the accountant role. The column guard
-- (002) lets it change "active" (and the log, as before); everything else still needs sellouts.edit.
-- ADDITIVE (the guard function is replaced with the same rules plus "active").

insert into public.permissions (key, grp, label, sort)
values ('sellouts.activate', 'Sell-outs', 'Turn on / off', 2)
on conflict (key) do nothing;

insert into public.role_permissions (role, perm) values ('accountant', 'sellouts.activate')
on conflict do nothing;

create or replace function public.sellouts_perm_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare n jsonb := to_jsonb(new); o jsonb := to_jsonb(old); k text; need text;
begin
  if auth.uid() is null then return new; end if;
  for k in select jsonb_object_keys(n) loop
    if n -> k is distinct from o -> k then
      if k = 'active' then
        if not public.has_perm('sellouts.edit', 'sellouts.activate') then
          raise exception 'You are not allowed to turn a sell-out on or off' using errcode = '42501';
        end if;
        continue;
      end if;
      need := case
        when k in ('archived', 'archived_at', 'archived_by') then 'sellouts.archive'
        when k in ('priced_items', 'pricing', 'price_column') then 'sellouts.price'
        when k in ('log', 'notified_flags', 'updated_at') then null
        else 'sellouts.edit' end;
      if need is not null and not public.has_perm(need) then
        raise exception 'You are not allowed to change "%" on a sell-out', k using errcode = '42501';
      end if;
    end if;
  end loop;
  return new;
end $$;
