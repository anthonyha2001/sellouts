-- 019 — Floor manager (owner, 2026-09-30): rented spot check + promo lady attendance (no photos).
-- 1. rentals.spotcheck: walk the store and confirm every rented spot holds the supplier who pays for it;
--    reads the store map and the contracts (read only). Default: floor manager.
-- 2. spot_checks: one check = the rented spots at the start (items) with what was found, plus spots used
--    without a contract (extra). One open check at a time.
-- 3. promo_lady_attendance: per booking and day — came / didn't come, hours, note.
-- ADDITIVE.

insert into public.permissions (key, grp, label, sort) values ('rentals.spotcheck', 'Rentals', 'Check rented spots on the floor', 34)
on conflict (key) do nothing;
insert into public.role_permissions (role, perm) values ('floor_manager', 'rentals.spotcheck') on conflict do nothing;

-- The map and the contracts are readable for the spot check (writing stays with rentals.layout / contracts).
do $$
declare t text;
begin
  foreach t in array array['store_floors','store_map_objects','store_map_config','rental_contracts'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_perm(''rentals.view'', ''rentals.spotcheck''))', t || '_read', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Spot checks
-- ---------------------------------------------------------------------------
create table if not exists public.spot_checks (
  id               uuid primary key default gen_random_uuid(),
  started_by       uuid not null default auth.uid(),
  started_by_name  text,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  items            jsonb not null default '[]',   -- [{spotId, type, label, floor, near, contractId, supplier, status, found, note, at}]
  extra            jsonb not null default '[]',   -- [{spotId, type, label, floor, near, found, note, at}] used without a contract
  summary          jsonb
);
create unique index if not exists spot_checks_one_open on public.spot_checks ((true)) where completed_at is null;
create index if not exists spot_checks_started_idx on public.spot_checks (started_at desc);

create or replace function public.spot_checks_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.started_by := coalesce(auth.uid(), new.started_by);
    select coalesce(display_name, username) into new.started_by_name from public.profiles where id = new.started_by;
  else
    new.started_by := old.started_by; new.started_by_name := old.started_by_name; new.started_at := old.started_at;
    if old.completed_at is not null and not public.has_perm('rentals.contracts') then
      raise exception 'This spot check is finished' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists spot_checks_stamp on public.spot_checks;
create trigger spot_checks_stamp before insert or update on public.spot_checks
  for each row execute function public.spot_checks_stamp();

alter table public.spot_checks enable row level security;
revoke all on public.spot_checks from anon;
revoke truncate, references, trigger on public.spot_checks from authenticated;
drop policy if exists spot_checks_read on public.spot_checks;
drop policy if exists spot_checks_write on public.spot_checks;
drop policy if exists spot_checks_update on public.spot_checks;
drop policy if exists spot_checks_delete on public.spot_checks;
create policy spot_checks_read   on public.spot_checks for select to authenticated using (public.has_perm('rentals.spotcheck', 'rentals.view'));
create policy spot_checks_write  on public.spot_checks for insert to authenticated with check (public.has_perm('rentals.spotcheck'));
create policy spot_checks_update on public.spot_checks for update to authenticated
  using (public.has_perm('rentals.spotcheck', 'rentals.contracts')) with check (public.has_perm('rentals.spotcheck', 'rentals.contracts'));
create policy spot_checks_delete on public.spot_checks for delete to authenticated using (public.has_perm('rentals.contracts'));

-- ---------------------------------------------------------------------------
-- Promo lady attendance
-- ---------------------------------------------------------------------------
create table if not exists public.promo_lady_attendance (
  promo_lady_id  uuid not null references public.promo_ladies(id) on delete cascade,
  day            date not null,
  came           boolean not null,
  time_from      text check (time_from is null or time_from ~ '^\d{2}:\d{2}$'),
  time_to        text check (time_to is null or time_to ~ '^\d{2}:\d{2}$'),
  note           text,
  checked_by     uuid default auth.uid(),
  checked_at     timestamptz not null default now(),
  primary key (promo_lady_id, day)
);
alter table public.promo_lady_attendance enable row level security;
revoke all on public.promo_lady_attendance from anon;
revoke truncate, references, trigger on public.promo_lady_attendance from authenticated;
drop policy if exists promo_lady_attendance_all on public.promo_lady_attendance;
create policy promo_lady_attendance_all on public.promo_lady_attendance for all to authenticated
  using (public.has_perm('promoladies.manage')) with check (public.has_perm('promoladies.manage'));
