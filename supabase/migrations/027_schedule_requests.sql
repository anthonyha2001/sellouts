-- 027 — Schedule requests (owner, 2026-10-01): instead of the WhatsApp group, each cashier / supervisor
-- sends their wishes for an upcoming week from the cashier page (PIN, through the cashier-view
-- function): per day AM / PM / Full / Off ('' = any), and a note. HR (schedule.manage) reads them on
-- the Staff schedule page; supervisors see them in their draft (through the function). They can be
-- changed until the week is published.
-- ADDITIVE.

create table if not exists public.schedule_requests (
  week_start  date not null check (extract(isodow from week_start) = 1),   -- Monday
  cashier_id  uuid not null references public.cashiers(id) on delete cascade,
  days        jsonb not null default '["","","","","","",""]',            -- Mon→Sun: '' | am | pm | full | off
  note        text,
  updated_at  timestamptz not null default now(),
  primary key (week_start, cashier_id)
);
alter table public.schedule_requests enable row level security;
revoke all on public.schedule_requests from anon, authenticated;
grant select on public.schedule_requests to authenticated;
drop policy if exists schedule_requests_read on public.schedule_requests;
create policy schedule_requests_read on public.schedule_requests for select to authenticated
  using (public.has_perm('schedule.manage'));

-- Live updates on the Staff schedule page (migration 021).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'schedule_requests') then
    alter publication supabase_realtime add table public.schedule_requests;
  end if;
end $$;
