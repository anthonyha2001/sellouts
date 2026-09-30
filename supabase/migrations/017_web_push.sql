-- 017 — Notifications while the app is closed (Web Push) (PLAN §10e).
-- A device that turns notifications on registers here (register_push). Every 10 minutes pg_cron calls
-- the push-alerts edge function, which works out the alerts (sell-outs, vendor orders, cash, floor check,
-- rentals, labels) and pushes each one once to the people whose permissions cover it (push_log).
-- Run after 014 (permissions). Needs, once (see PLAN §10e for the commands):
--   * the Vault secret 'push_cron_secret' (same value as the function's PUSH_CRON_SECRET),
--   * the push-alerts function deployed with its secrets.

-- 0. The Tools permission (added to 014 after 014 was applied here): needed to give Tools to someone.
insert into public.permissions (key, grp, label, sort) values ('tools.convert', 'Tools', 'PDF / photo to Excel', 32)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Devices
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  failures    integer not null default 0
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
revoke insert, update, delete, truncate, references, trigger on public.push_subscriptions from authenticated;
drop policy if exists push_subscriptions_read on public.push_subscriptions;
create policy push_subscriptions_read on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid() or public.is_role('admin'));

-- This device now notifies the signed-in user (a device used by someone else before moves over).
create or replace function public.register_push(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and active) then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 or length(p_p256dh) > 200 or length(p_auth) > 100 then
    raise exception 'Bad subscription';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, failures = 0;
end $$;
-- Turned off on this device, or signing out: stop notifying it.
create or replace function public.unregister_push(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and (user_id = auth.uid() or public.is_role('admin'));
$$;
revoke execute on function public.register_push(text, text, text, text) from public, anon;
revoke execute on function public.unregister_push(text) from public, anon;
grant execute on function public.register_push(text, text, text, text) to authenticated;
grant execute on function public.unregister_push(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. What was already sent (one alert, one person, once) — server only
-- ---------------------------------------------------------------------------
create table if not exists public.push_log (
  key      text not null,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  sent_at  timestamptz not null default now(),
  primary key (key, user_id)
);
alter table public.push_log enable row level security;          -- no policies: only the service role
revoke all on public.push_log from anon, authenticated;

-- A user's effective permissions (same rule as has_perm), for the function (service role only).
create or replace function public.perms_of(p_user uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select case when pr.role = 'admin' then (select array_agg(key) from public.permissions)
    else coalesce((select array_agg(p.key) from public.permissions p
                   where coalesce((select up.allowed from public.user_permissions up where up.user_id = pr.id and up.perm = p.key),
                                  exists (select 1 from public.role_permissions rp where rp.role = pr.role and rp.perm = p.key))), '{}') end
  from public.profiles pr where pr.id = p_user and pr.active
$$;
revoke execute on function public.perms_of(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Every 10 minutes: run the alerts
-- ---------------------------------------------------------------------------
create extension if not exists pg_net;
create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'push-alerts') then perform cron.unschedule('push-alerts'); end if;
end $$;
select cron.schedule('push-alerts', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/push-alerts',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"run"}'::jsonb,
    timeout_milliseconds := 30000)
$job$);

-- Keep push_log small: forget what was sent more than 60 days ago.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'push-log-cleanup') then perform cron.unschedule('push-log-cleanup'); end if;
end $$;
select cron.schedule('push-log-cleanup', '17 3 * * *', $job$ delete from public.push_log where sent_at < now() - interval '60 days' $job$);
