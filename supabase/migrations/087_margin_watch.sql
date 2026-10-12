-- 087 — Margin watch (owner, 2026-10-12). Every item bought (a PU, today and yesterday) is checked once against its previous PU and its
--   price now (lv-dashboard margin_watch, every 10 minutes from 07:00, about 60 items a run):
--   kind 'cost_up'    the unit cost (free units counted, VAT added when the PU has it) is 3% and $0.02 or more above the previous PU,
--                     and no new price was sent from Pricing since: the price did not follow the cost;
--   kind 'below_cost' the price now is at or below the cost with VAT (items on promotion left out);
--   kind 'check_unit' the cost is more than twice the price: a PU in cases against a price per piece, most likely - to check, not a loss;
--   other kinds (no flag): null = fine, 'other_currency' (price in LBP, cost in $), 'no_previous', 'failed' (could not be read).
--   An open flag closes by itself (resolved_at, resolved_how) when a new price is sent from Pricing or the price goes up enough.
-- Additive only: a new table and a cron job.
create table if not exists public.margin_checks (
  day date not null,
  code text not null,
  description text,
  supplier text,
  doc text,
  currency text,
  vat boolean,
  cost numeric,
  prev_cost numeric,
  prev_day date,
  prev_doc text,
  cost_change numeric,
  sale_price numeric,
  sale_currency text,
  promoted boolean,
  margin numeric,
  prev_margin numeric,
  kind text,
  checked_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_how text,
  primary key (day, code)
);
create index if not exists margin_checks_open on public.margin_checks (kind) where resolved_at is null and kind in ('cost_up', 'below_cost', 'check_unit');
alter table public.margin_checks enable row level security;
drop policy if exists margin_checks_read on public.margin_checks;
create policy margin_checks_read on public.margin_checks for select to authenticated using (public.has_perm('vendors.manage'));

do $$
begin
  if exists (select 1 from cron.job where jobname = 'margin-watch') then perform cron.unschedule('margin-watch'); end if;
end $$;
-- every 10 minutes, 04:00 – 17:50 UTC = 07:00 – 20:50 Beirut
select cron.schedule('margin-watch', '3-59/10 4-17 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"margin_watch"}'::jsonb,
    timeout_milliseconds := 140000)
$job$);
