-- 055 — Cash count (owner, 2026-10-04): the paper count sheet, in the app.
-- A count = one POS (1-8), one cashier, one shift, one date:
--   part 1 (cashier supervisors / accountant — cashcount.count): LBP bills (100k 50k 20k 10k 5k 1k), USD bills
--     (100 50 20 10 5 1), card lines in LBP and USD (Visa Bankmed, Master Bankmed, Areeba, CCM Master, CCM Visa,
--     On account, Amex, Special voucher, Points); the cashier signs with their PIN.
--   part 2 (accountant — cashcount.reconcile): the system's figures, each card line found / not found; the
--     differences are worked out by the app (a card not found is charged to the cashier's cash).
--   the grid of all counts (accountant / HR — cashcount.view).
-- Admin only until the rights are given (no role gets them by default).
-- USD rate: cash_settings.usd_rate (changes rarely); each count keeps the rate it was made with.
-- ADDITIVE.

insert into public.permissions (key, grp, label, sort) values
  ('cashcount.count', 'Cash count', 'Count a cashier''s drawer (bills, cards) and have the cashier sign', 60),
  ('cashcount.reconcile', 'Cash count', 'Enter the system figures, card found / not found, reconcile', 61),
  ('cashcount.view', 'Cash count', 'See the cash count grid (differences)', 62)
on conflict (key) do nothing;

alter table public.cash_settings add column if not exists usd_rate numeric;

create table if not exists public.cash_counts (
  id              uuid primary key default gen_random_uuid(),
  count_date      date not null default public.beirut_today(),
  pos             integer not null check (pos between 1 and 8),
  shift           text not null check (shift in ('am', 'pm', 'full')),
  cashier_id      uuid references public.cashiers on delete set null,
  cashier_name    text not null,
  lbp             jsonb not null default '{}',     -- {"100000": 12, "50000": 3, …} bills counted
  usd             jsonb not null default '{}',     -- {"100": 2, "50": 1, …}
  cards           jsonb not null default '{}',     -- {"visa_bankmed": {"lbp": 0, "usd": 0}, …} slips counted
  signed_at       timestamptz,                     -- the cashier confirmed with their PIN
  counted_by      uuid default auth.uid(),
  counted_by_name text,
  system          jsonb not null default '{}',     -- {"cash_lbp": …, "cash_usd": …, "cards": {"visa_bankmed": {"lbp", "usd"}, …}}
  not_found       jsonb not null default '{}',     -- {"amex": true} card lines whose slips were not found
  usd_rate        numeric,
  reconciled_at   timestamptz,
  reconciled_by   uuid,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (count_date, pos, shift)
);
create index if not exists cash_counts_date_idx on public.cash_counts (count_date desc);
alter table public.cash_counts enable row level security;
revoke all on public.cash_counts from anon;
grant select, insert, update, delete on public.cash_counts to authenticated;
drop policy if exists cash_counts_read on public.cash_counts;
create policy cash_counts_read on public.cash_counts for select to authenticated
  using (public.has_perm('cashcount.count', 'cashcount.reconcile', 'cashcount.view'));
drop policy if exists cash_counts_insert on public.cash_counts;
create policy cash_counts_insert on public.cash_counts for insert to authenticated
  with check (public.has_perm('cashcount.count'));
drop policy if exists cash_counts_update on public.cash_counts;
create policy cash_counts_update on public.cash_counts for update to authenticated
  using (public.has_perm('cashcount.count', 'cashcount.reconcile')) with check (public.has_perm('cashcount.count', 'cashcount.reconcile'));
drop policy if exists cash_counts_delete on public.cash_counts;
create policy cash_counts_delete on public.cash_counts for delete to authenticated
  using (public.is_role('admin'));

-- Who may change what: the count (part 1) with cashcount.count, and not once the cashier signed (unless
-- admin); the system side (part 2) with cashcount.reconcile only. Who counted / reconciled is stamped.
create or replace function public.cash_counts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare part1 boolean; part2 boolean; adm boolean := public.is_role('admin');
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.counted_by := auth.uid();
    select coalesce(display_name, username) into new.counted_by_name from public.profiles where id = auth.uid();
    new.signed_at := null; new.system := '{}'; new.not_found := '{}'; new.reconciled_at := null; new.reconciled_by := null;
    return new;
  end if;
  part1 := (new.lbp, new.usd, new.cards, new.pos, new.shift, new.cashier_id, new.cashier_name, new.count_date)
           is distinct from (old.lbp, old.usd, old.cards, old.pos, old.shift, old.cashier_id, old.cashier_name, old.count_date);
  part2 := (new.system, new.not_found, new.usd_rate, new.reconciled_at) is distinct from (old.system, old.not_found, old.usd_rate, old.reconciled_at);
  if part1 and not public.has_perm('cashcount.count') then raise exception 'You cannot change the count' using errcode = '42501'; end if;
  if part1 and old.signed_at is not null and not adm then raise exception 'The cashier already signed this count' using errcode = '42501'; end if;
  if part2 and not public.has_perm('cashcount.reconcile') then raise exception 'Only the accountant enters the system figures' using errcode = '42501'; end if;
  -- signing happens only through cash_count_sign(); a changed count needs a new signature
  if new.signed_at is distinct from old.signed_at and not (part1 and new.signed_at is null)
     and coalesce(current_setting('lv.cash_count_signing', true), '') <> '1' then new.signed_at := old.signed_at; end if;
  if part1 and adm and old.signed_at is not null then new.signed_at := null; end if;
  if new.reconciled_at is distinct from old.reconciled_at then new.reconciled_by := case when new.reconciled_at is null then null else auth.uid() end; end if;
  new.counted_by := old.counted_by; new.counted_by_name := old.counted_by_name; new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists cash_counts_guard on public.cash_counts;
create trigger cash_counts_guard before insert or update on public.cash_counts
  for each row execute function public.cash_counts_guard();

-- The cashier signs with their cashier-page PIN (same check and lock-out as the cashier page).
create or replace function public.cash_count_sign(p_count uuid, p_pin text) returns text
language plpgsql security definer set search_path = public as $$
declare c public.cash_counts; r record;
begin
  if not public.has_perm('cashcount.count') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into c from public.cash_counts where id = p_count;
  if c.id is null or c.cashier_id is null then return 'no_cashier'; end if;
  select * into r from public.cashier_verify_pin(c.cashier_id, p_pin);
  if r.status <> 'ok' then return r.status || coalesce(':' || r.attempts_left, ''); end if;
  perform set_config('lv.cash_count_signing', '1', true);   -- lets the guard accept the signature
  update public.cash_counts set signed_at = now() where id = p_count;
  perform set_config('lv.cash_count_signing', '', true);
  return 'ok';
end $$;
revoke execute on function public.cash_count_sign(uuid, text) from public, anon;
grant execute on function public.cash_count_sign(uuid, text) to authenticated;

-- The USD rate (cash_settings), for the accountant too.
create or replace function public.set_usd_rate(p_rate numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm('cashcount.reconcile', 'cash.cashiers') then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_rate is null or p_rate <= 0 then raise exception 'Bad rate'; end if;
  update public.cash_settings set usd_rate = p_rate where id = 'app';
end $$;
revoke execute on function public.set_usd_rate(numeric) from public, anon;
grant execute on function public.set_usd_rate(numeric) to authenticated;
create or replace function public.get_usd_rate() returns numeric
language sql stable security definer set search_path = public as $$
  select usd_rate from public.cash_settings where id = 'app'
$$;
revoke execute on function public.get_usd_rate() from public, anon;
grant execute on function public.get_usd_rate() to authenticated;

-- The cashiers list (names for the count) for the cash count rights too.
drop policy if exists cashiers_read on public.cashiers;
create policy cashiers_read on public.cashiers for select to authenticated
  using (public.has_perm('cash.view', 'cash.cashiers', 'cash.enter', 'schedule.manage', 'schedule.edit', 'staff.manage',
                         'cashcount.count', 'cashcount.reconcile', 'cashcount.view'));

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cash_counts') then
    alter publication supabase_realtime add table public.cash_counts;
  end if;
end $$;
