-- 095 — Returns tracker (owner, 2026-10-13): a dedicated page listing every PT (return to a supplier) with a status the owner
--   sets: Taken / Compensated / Traded / Owner. Deriving PTs live is slow (85 s for a week, and it truncates), so a sync reads a
--   small rolling window every 30 minutes (lv-dashboard pts_sync, from returns_range) and keeps the PT headers here; the owner's
--   status and note are never touched by the sync. The page reads this table, instant.
-- Additive only: a table and a cron job.
create table if not exists public.pts (
  pt text not null,
  year text not null,
  pt_date date,
  supplier_code text,
  supplier_name text,
  lines integer,
  qty numeric,
  value numeric,                 -- signed total (returns are negative); the page shows the absolute
  currency text,
  status text check (status is null or status in ('taken', 'compensated', 'traded', 'owner')),
  note text,
  status_by uuid,
  status_by_name text,
  status_at timestamptz,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (pt, year)
);
create index if not exists pts_date on public.pts (pt_date desc);
create index if not exists pts_supplier on public.pts (supplier_code);

alter table public.pts enable row level security;
revoke all on public.pts from anon;
grant select, insert, update on public.pts to authenticated;
drop policy if exists pts_read on public.pts;
create policy pts_read on public.pts for select to authenticated using (public.has_perm('vendors.manage'));
drop policy if exists pts_update on public.pts;
create policy pts_update on public.pts for update to authenticated using (public.has_perm('vendors.manage')) with check (public.has_perm('vendors.manage'));

-- the status stamp is set by the server, never trusted from the client; the sync (service role) never changes the status
create or replace function public.pts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then                     -- the sync: keep the owner's status and note
    new.status := old.status; new.note := old.note; new.status_by := old.status_by; new.status_by_name := old.status_by_name; new.status_at := old.status_at;
    return new;
  end if;
  if new.status is distinct from old.status or new.note is distinct from old.note then
    select coalesce(nullif(trim(display_name), ''), username) into new.status_by_name from public.profiles where id = auth.uid();
    new.status_by := auth.uid(); new.status_at := now();
  end if;
  return new;
end $$;
drop trigger if exists pts_guard on public.pts;
create trigger pts_guard before update on public.pts for each row execute function public.pts_guard();

-- every 30 minutes, 07:00–21:00 Beirut: sync the recent PTs
do $$ begin if exists (select 1 from cron.job where jobname = 'pts-sync') then perform cron.unschedule('pts-sync'); end if; end $$;
select cron.schedule('pts-sync', '*/30 4-18 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"pts_sync"}'::jsonb,
    timeout_milliseconds := 150000)
$job$);
