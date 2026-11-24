-- 107 — The relay to the dashboard (owner, 2026-11-24): the dashboard's Cloudflare blocks the Supabase servers, so
-- lv-dashboard goes through scripts/relay.mjs on the office computer in Lebanon. The relay keeps ONE row here: its current
-- tunnel address, a fresh secret key, and when it last checked in. Only the server (service role) reads or writes it.
-- The relay creates this table itself at start; this file is the record. ADDITIVE.
create table if not exists public.app_relay (id int primary key check (id = 1), url text, key text, seen_at timestamptz);
alter table public.app_relay enable row level security;
revoke all on public.app_relay from anon, authenticated;
