-- 049 — Who turned notifications on and who installed the app (owner, 2026-10-04).
--   profiles.last_seen_at / installed_at: the app tells the server it was opened, and whether it runs as the
--     installed app (home-screen icon). installed_at = the first time it was opened installed.
--   cashiers.installed_at: the same for the cashier page (sent by cashier-view with the "view" call).
--   mark_app_seen(installed): the signed-in person, about themselves only.
--   staff_app_usage() (admin): every app user — notifications on how many devices, installed, last seen.
--   cashier_app_usage() (admin, cash.cashiers, staff.manage): the same for the cashier page.
-- Notifications were already recorded (push_subscriptions 017, cashier_push_subscriptions 023).
-- ADDITIVE.

alter table public.profiles add column if not exists last_seen_at timestamptz;
alter table public.profiles add column if not exists installed_at timestamptz;
alter table public.cashiers add column if not exists installed_at timestamptz;
grant select (installed_at) on public.cashiers to authenticated;

create or replace function public.mark_app_seen(p_installed boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  update public.profiles
     set last_seen_at = now(),
         installed_at = case when p_installed then coalesce(installed_at, now()) else installed_at end
   where id = auth.uid();
end $$;
revoke execute on function public.mark_app_seen(boolean) from public, anon;
grant execute on function public.mark_app_seen(boolean) to authenticated;

create or replace function public.staff_app_usage()
returns table (user_id uuid, devices integer, last_ok_at timestamptz, installed_at timestamptz, last_seen_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_role('admin') then raise exception 'Not allowed' using errcode = '42501'; end if;
  return query
    select p.id, (select count(*)::int from public.push_subscriptions s where s.user_id = p.id),
           (select max(s.last_ok_at) from public.push_subscriptions s where s.user_id = p.id),
           p.installed_at, p.last_seen_at
      from public.profiles p;
end $$;
revoke execute on function public.staff_app_usage() from public, anon;
grant execute on function public.staff_app_usage() to authenticated;

create or replace function public.cashier_app_usage()
returns table (cashier_id uuid, devices integer, last_ok_at timestamptz, installed_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_perm('cash.cashiers', 'staff.manage') then raise exception 'Not allowed' using errcode = '42501'; end if;
  return query
    select c.id, (select count(*)::int from public.cashier_push_subscriptions s where s.cashier_id = c.id),
           (select max(s.last_ok_at) from public.cashier_push_subscriptions s where s.cashier_id = c.id),
           c.installed_at
      from public.cashiers c;
end $$;
revoke execute on function public.cashier_app_usage() from public, anon;
grant execute on function public.cashier_app_usage() to authenticated;
