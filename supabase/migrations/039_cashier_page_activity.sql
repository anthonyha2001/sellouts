-- 039 — What cashiers do on the cashier page goes into the activity log (owner, 2026-10-03).
--   activity_log_stamp(): an entry written by the server (cashier-view function, no signed-in user) keeps
--     the name and role it was given ("Maya", cashier); an app user's entry is still stamped from their
--     account, so nobody can write under someone else's name.
--   cashiers.last_seen_at: when the cashier last opened the page (Cash > Cashiers & settings).
-- ADDITIVE.

create or replace function public.activity_log_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.at := now();
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select p.username, p.role into new.username, new.role from public.profiles p where p.id = auth.uid();
  end if;
  return new;
end $$;

alter table public.cashiers add column if not exists last_seen_at timestamptz;
grant select (last_seen_at) on public.cashiers to authenticated;
