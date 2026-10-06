-- 067 — New sale prices sent from Pricing to the floor manager (owner, 2026-10-06).
--   Pricing: the new sale prices typed on a day's PUs are submitted. Each one is a "ghost price" until the system
--   (the dashboard) really has it: lv-dashboard checks the system's sale price of the pending ones (Floor check
--   "Check now", and every 15 minutes in the day with the stock watch) and marks them synced when it equals the
--   new price. The floor manager sees them in Floor check (New prices) and ticks the shelf label done.
--   One pending price per item: submitting again for the same item cancels the older pending one (kept, not deleted).
-- ADDITIVE (one table, its policies, a trigger for the names).

create table if not exists public.price_changes (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null,
  description        text,
  barcode            text,
  supplier           text,
  doc                text,                 -- the PU it came from
  day                date,                 -- the PU's day
  vat                boolean,
  currency           text,                 -- of the sale price ($ / LBP)
  old_price          numeric,              -- the system's sale price when it was submitted
  new_price          numeric not null,
  cost               numeric,              -- the PU's net price
  cost_currency      text,
  prev_cost          numeric,
  cost_change        text,                 -- 'Price increase' / 'Price decrease' / ''
  status             text not null default 'pending' check (status in ('pending', 'synced', 'cancelled')),
  system_price       numeric,              -- the system's sale price at the last check
  checked_at         timestamptz,
  synced_at          timestamptz,
  submitted_by       uuid default auth.uid(),
  submitted_by_name  text,
  submitted_at       timestamptz not null default now(),
  floor_done_at      timestamptz,
  floor_done_by      uuid,
  floor_done_by_name text
);
create index if not exists price_changes_pending on public.price_changes (code) where status = 'pending';
create index if not exists price_changes_recent on public.price_changes (submitted_at desc);

-- the names of who submitted / who ticked the label done
create or replace function public.price_changes_names() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.submitted_by := coalesce(new.submitted_by, auth.uid());
    select coalesce(p.display_name, p.username) into new.submitted_by_name from public.profiles p where p.id = new.submitted_by;
  end if;
  if new.floor_done_at is not null and (tg_op = 'INSERT' or old.floor_done_at is null) then
    new.floor_done_by := auth.uid();
    select coalesce(p.display_name, p.username) into new.floor_done_by_name from public.profiles p where p.id = auth.uid();
  end if;
  if new.floor_done_at is null then new.floor_done_by := null; new.floor_done_by_name := null; end if;
  return new;
end $$;
drop trigger if exists price_changes_names on public.price_changes;
create trigger price_changes_names before insert or update on public.price_changes for each row execute function public.price_changes_names();

alter table public.price_changes enable row level security;
drop policy if exists price_changes_read on public.price_changes;
create policy price_changes_read on public.price_changes for select to authenticated
  using (public.has_perm('vendors.manage', 'floorcheck.do', 'floorcheck.manage'));
drop policy if exists price_changes_insert on public.price_changes;
create policy price_changes_insert on public.price_changes for insert to authenticated
  with check (public.has_perm('vendors.manage'));
-- vendors.manage: cancel its pending prices; the floor: tick the label done
drop policy if exists price_changes_update on public.price_changes;
create policy price_changes_update on public.price_changes for update to authenticated
  using (public.has_perm('vendors.manage', 'floorcheck.do', 'floorcheck.manage'))
  with check (public.has_perm('vendors.manage', 'floorcheck.do', 'floorcheck.manage'));
