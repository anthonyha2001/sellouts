-- 076 — Daily stock snapshots and unexplained stock movements (owner, 2026-10-11). Run after 075.
--   stock_snapshots     : the stock of every item that moved in the last year (sold in the last 90 days or bought in
--                         the last 12 months), once a day. Read in the night, ~600 items every 2 minutes: the system
--                         has no bulk stock report, so it is item by item.
--   stock_snapshot_runs : one row per day: how many items to read, how many were, when it finished.
--   stock_moves         : per item, yesterday's stock -> today's against what the documents explain
--                         (bought - sold). unexplained = change - (bought - sold): a count, an adjustment, a loss,
--                         a return, a wrong entry. Kept 60 days.
-- Additive only: three new tables and one cron job.

create table if not exists public.stock_snapshots (
  day date not null,
  code text not null,
  description text,
  supplier text,
  stock numeric,                    -- null until read (or when the system did not answer)
  read_at timestamptz,
  primary key (day, code)
);
create index if not exists stock_snapshots_unread on public.stock_snapshots (day) where read_at is null;
create index if not exists stock_snapshots_code on public.stock_snapshots (code, day desc);

create table if not exists public.stock_snapshot_runs (
  day date primary key,
  total integer not null default 0,
  read integer not null default 0,
  list_stage integer not null default 0,   -- 1: sold in the last 90 days listed, 2: + bought in the last 12 months
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  diff_done boolean not null default false
);

create table if not exists public.stock_moves (
  day date not null,
  code text not null,
  description text,
  supplier text,
  stock_prev numeric,
  stock_now numeric,
  bought numeric,
  sold numeric,
  unexplained numeric,
  primary key (day, code)
);

alter table public.stock_snapshots enable row level security;
alter table public.stock_snapshot_runs enable row level security;
alter table public.stock_moves enable row level security;
drop policy if exists stock_snapshots_read on public.stock_snapshots;
create policy stock_snapshots_read on public.stock_snapshots for select to authenticated using (public.has_perm('vendors.manage'));
drop policy if exists stock_snapshot_runs_read on public.stock_snapshot_runs;
create policy stock_snapshot_runs_read on public.stock_snapshot_runs for select to authenticated using (public.has_perm('vendors.manage'));
drop policy if exists stock_moves_read on public.stock_moves;
create policy stock_moves_read on public.stock_moves for select to authenticated using (public.has_perm('vendors.manage'));

do $$
begin
  if exists (select 1 from cron.job where jobname = 'stock-snapshot') then perform cron.unschedule('stock-snapshot'); end if;
end $$;
-- every 2 minutes from 21:00 to 03:58 UTC = 00:00 to 06:58 Beirut (summer time): the day just ended.
-- Each call reads as many items as fit in ~85 s (about 600): ~210 calls = 150,000 items in a night.
select cron.schedule('stock-snapshot', '*/2 21-23,0-3 * * *', $job$
  select net.http_post(
    url := 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/lv-dashboard',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')),
    body := '{"action":"stock_snapshot"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
