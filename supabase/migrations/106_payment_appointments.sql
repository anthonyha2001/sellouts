-- 106 — Supplier payment appointments (owner, 2026-11-23): a calendar to give suppliers a day (and a
-- time, when one is set) to come and be paid. Any day, any time; several on the same time are allowed.
-- Each appointment: supplier (from Vendors, or typed), day, time (optional), note, and its status —
--   booked -> paid | no_show (didn't come) | moved (to another appointment: moved_to).
-- Who changed the status and when is stamped by the database (status_by, status_by_name, status_at).
-- Access: permission 'payments.appointments' — accountant and admin by default (Users -> Permissions for
-- others); they may read the vendors' names for the supplier picker.
-- ADDITIVE: a new table, permission and policies.

insert into public.permissions (key, grp, label, sort)
values ('payments.appointments', 'Payments', 'Supplier payment appointments: book, move, mark paid / didn''t come', 37)
on conflict (key) do nothing;
insert into public.role_permissions (role, perm) values ('accountant', 'payments.appointments') on conflict do nothing;

create table if not exists public.payment_appointments (
  id              uuid primary key default gen_random_uuid(),
  supplier        text not null check (length(trim(supplier)) > 0),
  day             date not null,
  at_time         time,                                        -- null = any time that day
  note            text,
  status          text not null default 'booked' check (status in ('booked', 'paid', 'no_show', 'moved')),
  moved_to        uuid references public.payment_appointments(id) on delete set null,
  status_by       uuid,
  status_by_name  text,
  status_at       timestamptz,
  created_by      uuid default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists payment_appointments_day_idx on public.payment_appointments (day, at_time);

-- Who booked it, and who changed the status and when: from the signed-in user, never from the page.
create or replace function public.payment_appointments_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  select coalesce(display_name, username) into who from public.profiles where id = auth.uid();
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_by_name := coalesce(who, new.created_by_name);
    if new.status <> 'booked' then new.status_by := auth.uid(); new.status_by_name := who; new.status_at := now(); end if;
  elsif new.status is distinct from old.status then
    new.status_by := auth.uid(); new.status_by_name := who; new.status_at := now();
  else
    new.status_by := old.status_by; new.status_by_name := old.status_by_name; new.status_at := old.status_at;
  end if;
  return new;
end $$;
drop trigger if exists payment_appointments_stamp on public.payment_appointments;
create trigger payment_appointments_stamp before insert or update on public.payment_appointments
  for each row execute function public.payment_appointments_stamp();

alter table public.payment_appointments enable row level security;
revoke all on public.payment_appointments from anon;
revoke truncate, references, trigger on public.payment_appointments from authenticated;
grant select, insert, update, delete on public.payment_appointments to authenticated;
drop policy if exists payment_appointments_all on public.payment_appointments;
create policy payment_appointments_all on public.payment_appointments for all to authenticated
  using (public.has_perm('payments.appointments')) with check (public.has_perm('payments.appointments'));

-- The supplier picker: the vendors' names.
drop policy if exists vendors_payappts_read on public.vendors;
create policy vendors_payappts_read on public.vendors for select to authenticated using (public.has_perm('payments.appointments'));

-- Live updates on the page (migration 021).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'payment_appointments') then
    alter publication supabase_realtime add table public.payment_appointments;
  end if;
end $$;
