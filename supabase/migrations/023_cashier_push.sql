-- 023 — Notifications on cashiers' phones (owner, 2026-10-01): when a weekly program is published
-- (or changed after publishing) and when a cash difference is entered for them.
-- Cashiers have no login: a phone is registered through the cashier-view function after the PIN
-- check, and the push-alerts function (cron, every 10 minutes) sends the alerts.
-- Both tables are only used by those functions (service key): RLS on, no policies, no grants.
-- ADDITIVE.

create table if not exists public.cashier_push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  cashier_id  uuid not null references public.cashiers(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  failures    integer not null default 0
);
create index if not exists cashier_push_subscriptions_cashier on public.cashier_push_subscriptions (cashier_id);
alter table public.cashier_push_subscriptions enable row level security;
revoke all on public.cashier_push_subscriptions from anon, authenticated;

-- Each alert goes once to each cashier (the run that records it sends it).
create table if not exists public.cashier_push_log (
  key         text not null,
  cashier_id  uuid not null references public.cashiers(id) on delete cascade,
  sent_at     timestamptz not null default now(),
  primary key (key, cashier_id)
);
alter table public.cashier_push_log enable row level security;
revoke all on public.cashier_push_log from anon, authenticated;
