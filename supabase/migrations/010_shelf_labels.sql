-- 010 — Shelf labels and scanning (PLAN §10b, Phase 7).
-- ADDITIVE: a new role value, two new tables, one new column.
--   shelf worker : scans into their own open list, then submits it ("Done")
--   accountant / admin : see submitted lists, export them (ItemCode = barcode, Qty) and mark them exported
--   admin : may also scan
-- Nothing is deleted on export: lists are marked exported and hidden (history kept).

-- 1. The "shelf" role.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'accountant', 'delivery', 'floor_manager', 'shelf'));

-- 2. Label lists and their items.
create table if not exists public.label_lists (
  id           uuid primary key default gen_random_uuid(),
  created_by   uuid not null default auth.uid() references auth.users on delete restrict,
  created_at   timestamptz not null default now(),
  submitted_at timestamptz,
  exported_at  timestamptz,
  exported_by  uuid,
  created_by_name text          -- who scanned, kept on the list (the accountant cannot read other profiles)
);

create or replace function public.label_lists_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  select coalesce(p.display_name, p.username) into new.created_by_name from public.profiles p where p.id = new.created_by;
  return new;
end $$;
drop trigger if exists label_lists_stamp on public.label_lists;
create trigger label_lists_stamp before insert on public.label_lists
  for each row execute function public.label_lists_stamp();
-- One open (not yet submitted) list per person.
create unique index if not exists label_lists_one_open on public.label_lists (created_by) where submitted_at is null;

create table if not exists public.label_items (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references public.label_lists on delete cascade,
  barcode    text not null check (barcode ~ '^[0-9A-Za-z.\-]{1,64}$'),   -- as scanned, leading zeros kept
  qty        integer not null default 1 check (qty between 1 and 9999),
  scanned_at timestamptz not null default now(),
  unique (list_id, barcode)
);
create index if not exists label_items_list_idx on public.label_items (list_id);

-- Own open list (shelf worker or admin) = editable.
create or replace function public.label_list_editable(p_list uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.label_lists l
                 where l.id = p_list and l.created_by = auth.uid() and l.submitted_at is null
                   and public.is_role('shelf', 'admin'))
$$;
-- Own lists, or (accountant / admin) any submitted list.
create or replace function public.label_list_visible(p_list uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.label_lists l
                 where l.id = p_list
                   and ((l.created_by = auth.uid() and public.is_role('shelf', 'admin'))
                        or (l.submitted_at is not null and public.is_role('admin', 'accountant'))))
$$;
revoke execute on function public.label_list_editable(uuid) from public, anon;
revoke execute on function public.label_list_visible(uuid) from public, anon;
grant execute on function public.label_list_editable(uuid) to authenticated;
grant execute on function public.label_list_visible(uuid) to authenticated;

-- What may change on a list: the owner submits it once; accountant/admin mark a submitted list exported.
create or replace function public.label_lists_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  new.created_by := old.created_by; new.created_at := old.created_at;
  if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
    raise exception 'A submitted list cannot be reopened' using errcode = '42501';
  end if;
  if new.exported_at is distinct from old.exported_at then
    if not public.is_role('admin', 'accountant') then
      raise exception 'Only the accountant or an admin can export labels' using errcode = '42501';
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

alter table public.label_lists enable row level security;
alter table public.label_items enable row level security;
revoke all on public.label_lists, public.label_items from anon;
revoke truncate, references, trigger on public.label_lists, public.label_items from authenticated;

create policy label_lists_select on public.label_lists for select to authenticated
  using (public.label_list_visible(id));
create policy label_lists_insert on public.label_lists for insert to authenticated
  with check (public.is_role('shelf', 'admin') and created_by = auth.uid() and submitted_at is null and exported_at is null);
create policy label_lists_update on public.label_lists for update to authenticated
  using ((created_by = auth.uid() and submitted_at is null and public.is_role('shelf', 'admin'))
         or (submitted_at is not null and public.is_role('admin', 'accountant')))
  with check (created_by = auth.uid() or public.is_role('admin', 'accountant'));
create policy label_lists_delete on public.label_lists for delete to authenticated
  using (public.is_role('admin'));

create policy label_items_select on public.label_items for select to authenticated
  using (public.label_list_visible(list_id));
create policy label_items_insert on public.label_items for insert to authenticated
  with check (public.label_list_editable(list_id));
create policy label_items_update on public.label_items for update to authenticated
  using (public.label_list_editable(list_id)) with check (public.label_list_editable(list_id));
create policy label_items_delete on public.label_items for delete to authenticated
  using (public.label_list_editable(list_id));

-- 3. Floor check items remember the item's barcode, so the floor check can scan to an item.
alter table public.floor_check_items add column if not exists barcode text;
create index if not exists floor_check_items_barcode_idx on public.floor_check_items (check_id, barcode);
