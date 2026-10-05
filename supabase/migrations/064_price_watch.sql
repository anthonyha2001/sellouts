-- 064 — Watch the system's prices of the running sell-outs and promotions (owner, 2026-10-06).
--   Each night (every 15 minutes, 01:00 – 06:45 Beirut) lv-dashboard 'price_watch' reads the price of the items
--   of the running sell-outs and promotions (about 150 a round, each item once a day) and keeps it here. When an
--   item's price (or its normal price) is not the one of the night before, changed_at / prev_* are set: the floor
--   check lists it ("Price changed in the system") for the floor manager.
--   Written only by the server function (service role); read by the floor check (and sell-outs / promotions).
-- ADDITIVE (a new table, its read policy, a cron job).

create table if not exists public.item_price_watch (
  code            text primary key,
  description     text,
  price           numeric,          -- the price now (a promotion's price while it runs)
  sale_price      numeric,          -- the normal price
  promoted        boolean,
  prev_price      numeric,
  prev_sale_price numeric,
  sources         jsonb not null default '[]',   -- [{ kind: 'sellout' | 'promotion', id, name, supplier }]
  checked_at      timestamptz,
  changed_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists item_price_watch_changed on public.item_price_watch (changed_at desc);
alter table public.item_price_watch enable row level security;
drop policy if exists item_price_watch_read on public.item_price_watch;
create policy item_price_watch_read on public.item_price_watch for select to authenticated
  using (public.has_perm('floorcheck.do', 'floorcheck.manage', 'sellouts.view', 'promotions.view'));

do $$
begin
  if exists (select 1 from cron.job where jobname = 'price-watch') then perform cron.unschedule('price-watch'); end if;
end $$;
-- 22:00 – 03:45 UTC = 01:00 – 06:45 Beirut
select cron.schedule('price-watch', '*/15 22,23,0,1,2,3 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"price_watch"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
