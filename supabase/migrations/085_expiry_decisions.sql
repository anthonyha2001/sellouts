-- 085 — Expiries: sent to the admin, and the admin's decision (owner, 2026-10-12).
--   The floor manager sends the expiries to the admin; the admin sees each one with its supplier, its last purchase
--   and the supplier's contract, and decides: return to the supplier, repricing, the merchandiser will handle it, or
--   a request to the supplier's sales rep. Who decides: expiry.decide (the admin; can be given to others in Users).
-- ADDITIVE (new columns, one permission; the guard and the rules of 084 replaced with the same ones plus these).

insert into public.permissions (key, grp, label, sort) values
  ('expiry.decide', 'Expiries', 'Decide what happens to the expiries sent (return, repricing, merchandiser, sales)', 42)
on conflict (key) do update set grp = excluded.grp, label = excluded.label, sort = excluded.sort;

alter table public.expiries add column if not exists submitted_at      timestamptz;
alter table public.expiries add column if not exists submitted_by      uuid;
alter table public.expiries add column if not exists submitted_by_name text;
alter table public.expiries add column if not exists decision          text;
alter table public.expiries add column if not exists decision_note     text;
alter table public.expiries add column if not exists decided_at        timestamptz;
alter table public.expiries add column if not exists decided_by        uuid;
alter table public.expiries add column if not exists decided_by_name   text;
do $$ begin
  alter table public.expiries add constraint expiries_decision_chk check (decision is null or decision in ('return', 'reprice', 'merchandiser', 'sales'));
exception when duplicate_object then null; end $$;
create index if not exists expiries_to_decide_idx on public.expiries (submitted_at) where decision is null;

-- Stamps who / when; a shelf worker only marks done; only the floor manager sends; only expiry.decide decides.
create or replace function public.expiries_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare me text; mgr boolean; dec boolean;
begin
  new.updated_at := now();
  if auth.uid() is null then return new; end if;     -- service role / maintenance
  select coalesce(nullif(trim(display_name), ''), username) into me from public.profiles where id = auth.uid();
  mgr := public.has_perm('expiry.manage');
  dec := public.has_perm('expiry.decide');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_by_name := me; new.created_at := now();
    new.decision := null; new.decision_note := null; new.decided_at := null; new.decided_by := null; new.decided_by_name := null;
    if new.submitted_at is not null then new.submitted_at := now(); new.submitted_by := auth.uid(); new.submitted_by_name := me;
    else new.submitted_by := null; new.submitted_by_name := null; end if;
  else
    -- the stamps are never set by hand
    new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
    if not mgr then
      if (new.code, new.description, new.barcode, new.supplier, new.item_group, new.expiry_date, new.day_known, new.qty, new.location, new.note,
          new.assigned_staff, new.assigned_user)
         is distinct from
         (old.code, old.description, old.barcode, old.supplier, old.item_group, old.expiry_date, old.day_known, old.qty, old.location, old.note,
          old.assigned_staff, old.assigned_user) then
        raise exception 'Only the floor manager can change this expiry' using errcode = '42501';
      end if;
    end if;
    if new.submitted_at is distinct from old.submitted_at then
      if not mgr then raise exception 'Only the floor manager sends the expiries to the admin' using errcode = '42501'; end if;
      if new.submitted_at is not null then new.submitted_at := now(); new.submitted_by := auth.uid(); new.submitted_by_name := me;
      else new.submitted_by := null; new.submitted_by_name := null; end if;
    else
      new.submitted_by := old.submitted_by; new.submitted_by_name := old.submitted_by_name;
    end if;
    if (new.decision, new.decision_note) is distinct from (old.decision, old.decision_note) then
      if not dec then raise exception 'Only the admin decides what happens to an expiry' using errcode = '42501'; end if;
      if new.decision is distinct from old.decision then
        new.decided_at := case when new.decision is null then null else now() end;
        new.decided_by := case when new.decision is null then null else auth.uid() end;
        new.decided_by_name := case when new.decision is null then null else me end;
      else
        new.decided_at := old.decided_at; new.decided_by := old.decided_by; new.decided_by_name := old.decided_by_name;
      end if;
    else
      new.decided_at := old.decided_at; new.decided_by := old.decided_by; new.decided_by_name := old.decided_by_name;
    end if;
  end if;
  -- the shelf worker: from Staff (and their login), or an app user with the Shelf worker role
  if tg_op = 'INSERT' or new.assigned_staff is distinct from old.assigned_staff or new.assigned_user is distinct from old.assigned_user then
    if new.assigned_staff is not null then
      select s.name, s.user_id into new.assigned_name, new.assigned_user from public.staff s where s.id = new.assigned_staff;
    elsif new.assigned_user is not null then
      select coalesce(nullif(trim(p.display_name), ''), p.username) into new.assigned_name from public.profiles p where p.id = new.assigned_user;
    else
      new.assigned_name := null;
    end if;
    new.assigned_at := case when new.assigned_staff is null and new.assigned_user is null then null else now() end;
  else
    new.assigned_name := old.assigned_name; new.assigned_at := old.assigned_at;
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status = 'done' then
      new.done_at := now(); new.done_by := auth.uid(); new.done_by_name := me;
    else
      new.done_at := null; new.done_by := null; new.done_by_name := null; new.outcome := null; new.done_note := null;
    end if;
  else
    new.done_at := old.done_at; new.done_by := old.done_by; new.done_by_name := old.done_by_name;
  end if;
  return new;
end $$;

-- the admin (expiry.decide) sees and decides the expiries too
drop policy if exists expiries_read on public.expiries;
create policy expiries_read on public.expiries for select to authenticated
  using (public.has_perm('expiry.manage', 'expiry.decide') or (public.has_perm('expiry.work') and assigned_user = auth.uid()));
drop policy if exists expiries_update on public.expiries;
create policy expiries_update on public.expiries for update to authenticated
  using (public.has_perm('expiry.manage', 'expiry.decide') or (public.has_perm('expiry.work') and assigned_user = auth.uid()))
  with check (public.has_perm('expiry.manage', 'expiry.decide') or (public.has_perm('expiry.work') and assigned_user = auth.uid()));
