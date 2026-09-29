-- 006 — Floor check (PLAN §9.1): daily check of sell-out and promotion prices on the shelves
-- (promotions included: owner, 2026-09-29).
-- New tables + a private storage bucket. Nothing existing changes.
-- Who: floor_manager does checks and sees only their own; admin does/sees everything and is the
-- only one who marks a problem resolved. Items are a snapshot taken when the check starts.

create table if not exists public.floor_checks (
  id           uuid primary key default gen_random_uuid(),
  check_date   date not null default public.beirut_today(),
  started_by   uuid not null default auth.uid() references auth.users on delete restrict,
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  summary      jsonb,                 -- counts per status, filled on Finish
  unique (check_date, started_by)     -- one check per person per day; reopening resumes it
);

create table if not exists public.floor_check_items (
  id             uuid primary key default gen_random_uuid(),
  check_id       uuid not null references public.floor_checks on delete cascade,
  source         text not null default 'sellout' check (source in ('sellout', 'promotion')),
  sellout_id     text references public.sellouts on delete set null,
  promotion_id   text references public.promotions on delete set null,
  source_name    text,                -- sell-out / promotion name, kept for history if it is deleted
  item_key       text not null,       -- 'so:<sellout id>:<row>' or 'pr:<promotion row id>'
  item_row       integer,             -- row of the item in the sell-out file
  code           text,
  description    text,
  expected_price numeric,             -- sell-out new price / promotion promo price (null when not set)
  old_price      numeric,             -- regular price, shown for reference
  priority       integer not null default 1,   -- 0 = the sell-out / promotion starts or ends today
  sort_order     integer not null default 0,
  status         text not null default 'pending'
                 check (status in ('pending', 'ok', 'wrong_price', 'missing_tag', 'out_of_stock')),
  note           text,
  photo_path     text,                -- in the private 'floor-photos' bucket
  checked_at     timestamptz,
  checked_by     uuid,
  resolved       boolean not null default false,
  resolved_by    uuid,
  resolved_at    timestamptz,
  unique (check_id, item_key)
);
create index if not exists floor_check_items_check_idx on public.floor_check_items (check_id);
create index if not exists floor_check_items_code_idx on public.floor_check_items (code) where status not in ('pending', 'ok');

-- Can the current user work on this check? (admin: any; floor manager: own)
create or replace function public.can_use_floor_check(p_check uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.floor_checks c
    where c.id = p_check
      and (public.is_role('admin') or (public.is_role('floor_manager') and c.started_by = auth.uid()))
  )
$$;
revoke execute on function public.can_use_floor_check(uuid) from public, anon;
grant execute on function public.can_use_floor_check(uuid) to authenticated;

-- Item rules: stamps who/when; only admin resolves; a finished check is closed to the floor manager.
create or replace function public.floor_check_items_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare done timestamptz;
begin
  if auth.uid() is null then return new; end if;   -- service role / maintenance
  select completed_at into done from public.floor_checks where id = new.check_id;
  if tg_op = 'UPDATE' then
    if (new.resolved is distinct from old.resolved) then
      if not public.is_role('admin') then
        raise exception 'Only an admin can mark a problem resolved' using errcode = '42501';
      end if;
      new.resolved_by := case when new.resolved then auth.uid() end;
      new.resolved_at := case when new.resolved then now() end;
    end if;
    if done is not null and not public.is_role('admin')
       and (new.status, new.note, new.photo_path) is distinct from (old.status, old.note, old.photo_path) then
      raise exception 'This check is finished and can no longer be changed' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      new.checked_by := case when new.status = 'pending' then null else auth.uid() end;
      new.checked_at := case when new.status = 'pending' then null else now() end;
    end if;
  elsif done is not null and not public.is_role('admin') then
    raise exception 'This check is finished and can no longer be changed' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists floor_check_items_guard on public.floor_check_items;
create trigger floor_check_items_guard before insert or update on public.floor_check_items
  for each row execute function public.floor_check_items_guard();

-- A floor manager can finish their own check but not reopen it; started_by/date never change.
create or replace function public.floor_checks_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  new.started_by := old.started_by; new.check_date := old.check_date; new.started_at := old.started_at;
  if old.completed_at is not null and new.completed_at is null and not public.is_role('admin') then
    raise exception 'Only an admin can reopen a finished check' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists floor_checks_guard on public.floor_checks;
create trigger floor_checks_guard before update on public.floor_checks
  for each row execute function public.floor_checks_guard();

alter table public.floor_checks      enable row level security;
alter table public.floor_check_items enable row level security;
revoke all on public.floor_checks, public.floor_check_items from anon;
revoke truncate, references, trigger on public.floor_checks, public.floor_check_items from authenticated;

create policy floor_checks_select on public.floor_checks for select to authenticated
  using (public.is_role('admin') or (public.is_role('floor_manager') and started_by = auth.uid()));
create policy floor_checks_insert on public.floor_checks for insert to authenticated
  with check (public.is_role('admin', 'floor_manager') and started_by = auth.uid());
create policy floor_checks_update on public.floor_checks for update to authenticated
  using (public.is_role('admin') or (public.is_role('floor_manager') and started_by = auth.uid()))
  with check (public.is_role('admin') or (public.is_role('floor_manager') and started_by = auth.uid()));
create policy floor_checks_delete on public.floor_checks for delete to authenticated
  using (public.is_role('admin'));

create policy floor_items_select on public.floor_check_items for select to authenticated
  using (public.can_use_floor_check(check_id));
create policy floor_items_insert on public.floor_check_items for insert to authenticated
  with check (public.can_use_floor_check(check_id));
create policy floor_items_update on public.floor_check_items for update to authenticated
  using (public.can_use_floor_check(check_id)) with check (public.can_use_floor_check(check_id));
create policy floor_items_delete on public.floor_check_items for delete to authenticated
  using (public.is_role('admin'));

-- ---------------------------------------------------------------------------
-- Photos: private bucket; path = <user id>/<check id>/<item id>.jpg
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('floor-photos', 'floor-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists floor_photos_insert on storage.objects;
create policy floor_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'floor-photos' and public.is_role('admin', 'floor_manager')
              and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists floor_photos_select on storage.objects;
create policy floor_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'floor-photos'
         and (public.is_role('admin') or (public.is_role('floor_manager') and (storage.foldername(name))[1] = auth.uid()::text)));
drop policy if exists floor_photos_update on storage.objects;
create policy floor_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'floor-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists floor_photos_delete on storage.objects;
create policy floor_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'floor-photos'
         and (public.is_role('admin') or (storage.foldername(name))[1] = auth.uid()::text));
