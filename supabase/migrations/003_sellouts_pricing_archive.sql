-- 003 — Sell-outs: note, manual archiving, and pricing (PLAN §6.1).
-- ADDITIVE ONLY: new nullable/defaulted columns. `items` (the raw imported rows) is untouched.
-- Safe to run before or after 002; the existing sellouts policies cover the new columns.

alter table public.sellouts add column if not exists note          text;
alter table public.sellouts add column if not exists archived      boolean not null default false;
alter table public.sellouts add column if not exists archived_at   timestamptz;
alter table public.sellouts add column if not exists archived_by   uuid references auth.users on delete set null;
-- Header of the imported column used as the old price (e.g. 'Saleprice').
alter table public.sellouts add column if not exists price_column  text;
-- Last bulk rule applied, e.g. {"mode":"percent","value":20}.
alter table public.sellouts add column if not exists pricing       jsonb;
-- One entry per item row:
-- {"row":0,"code":"...","description":"...","oldPrice":3.5,"mode":"percent|amount|fixed|manual","value":20,"newPrice":2.8}
alter table public.sellouts add column if not exists priced_items  jsonb;

-- An archived sell-out must be inactive (archiving = confirmed removed from the store system).
alter table public.sellouts drop constraint if exists sellouts_archived_inactive;
alter table public.sellouts add constraint sellouts_archived_inactive check (not (archived and active));
