-- 060 — Cash count: the accountant can correct a signed count (flagged "modified"); the admin can delete (owner, 2026-10-05).
--   * A signed count (bills, slips, expenses, POS, shift, cashier, date) can be changed by the accountant
--     (cashcount.reconcile) or the admin. The cashier's signature stays; the count is flagged:
--     modified_at / modified_by / modified_by_name, and signed_snapshot keeps what the cashier signed (taken at
--     the first change after the signature). Before the signature, changes are part of the count: no flag.
--     (Until now the admin's change removed the signature; it is now flagged the same way.)
--   * Delete stays admin only (policy of 055). A count already sent to the Cash page: that cashier's day there is
--     worked out again from the counts left (or removed when none is left and it came from the cash count only).
--     Refused when that month is locked on the Cash page (the Cash page's own rule).
-- ADDITIVE (new columns, guard replaced with the new rule, a new trigger).

alter table public.cash_counts add column if not exists modified_at timestamptz;
alter table public.cash_counts add column if not exists modified_by uuid;
alter table public.cash_counts add column if not exists modified_by_name text;
alter table public.cash_counts add column if not exists signed_snapshot jsonb;

create or replace function public.cash_counts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare part1 boolean; part2 boolean; adm boolean := public.is_role('admin'); me text;
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.counted_by := auth.uid();
    select coalesce(display_name, username) into new.counted_by_name from public.profiles where id = auth.uid();
    new.signed_at := null; new.system := '{}'; new.not_found := '{}'; new.reconciled_at := null; new.reconciled_by := null;
    new.modified_at := null; new.modified_by := null; new.modified_by_name := null; new.signed_snapshot := null;
    return new;
  end if;
  part1 := (new.lbp, new.usd, new.cards, new.expenses, new.card_items, new.expense_items, new.pos, new.shift, new.cashier_id, new.cashier_name, new.count_date)
           is distinct from (old.lbp, old.usd, old.cards, old.expenses, old.card_items, old.expense_items, old.pos, old.shift, old.cashier_id, old.cashier_name, old.count_date);
  part2 := (new.system, new.not_found, new.usd_rate, new.reconciled_at, new.posted_amount, new.posted_at) is distinct from (old.system, old.not_found, old.usd_rate, old.reconciled_at, old.posted_amount, old.posted_at);
  if part1 and not public.has_perm('cashcount.count', 'cashcount.reconcile') then raise exception 'You cannot change the count' using errcode = '42501'; end if;
  if part1 and old.signed_at is not null and not (adm or public.has_perm('cashcount.reconcile')) then
    raise exception 'The cashier already signed this count: only the accountant can correct it' using errcode = '42501';
  end if;
  if part2 and not public.has_perm('cashcount.reconcile') then raise exception 'Only the accountant enters the system figures' using errcode = '42501'; end if;
  -- signing happens only through cash_count_sign()
  if new.signed_at is distinct from old.signed_at and coalesce(current_setting('lv.cash_count_signing', true), '') <> '1' then new.signed_at := old.signed_at; end if;
  -- a signed count changed: the signature stays, the count is flagged, and what the cashier signed is kept once
  if part1 and old.signed_at is not null and coalesce(current_setting('lv.cash_count_signing', true), '') <> '1' then
    select coalesce(display_name, username) into me from public.profiles where id = auth.uid();
    new.modified_at := now(); new.modified_by := auth.uid(); new.modified_by_name := me;
    if old.signed_snapshot is null then
      new.signed_snapshot := jsonb_build_object('signed_at', old.signed_at, 'lbp', old.lbp, 'usd', old.usd, 'cards', old.cards, 'expenses', old.expenses,
        'card_items', old.card_items, 'expense_items', old.expense_items, 'pos', old.pos, 'shift', old.shift, 'cashier_name', old.cashier_name, 'count_date', old.count_date);
    else new.signed_snapshot := old.signed_snapshot; end if;
  else
    new.modified_at := old.modified_at; new.modified_by := old.modified_by; new.modified_by_name := old.modified_by_name; new.signed_snapshot := old.signed_snapshot;
  end if;
  if new.reconciled_at is distinct from old.reconciled_at then new.reconciled_by := case when new.reconciled_at is null then null else auth.uid() end; end if;
  new.counted_by := old.counted_by; new.counted_by_name := old.counted_by_name; new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;

-- A deleted count that was sent to the Cash page: that cashier's day there is worked out again.
create or replace function public.cash_counts_after_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare total numeric; what text;
begin
  if old.posted_at is null or old.cashier_id is null then return old; end if;
  select sum(posted_amount), string_agg('POS ' || pos || ' ' || upper(shift) || ': ' || to_char(posted_amount, 'FM999,999,999,990'), ', ' order by pos)
    into total, what
    from public.cash_counts where cashier_id = old.cashier_id and count_date = old.count_date and posted_at is not null and id <> old.id;
  if total is null then
    delete from public.cash_differences where cashier_id = old.cashier_id and day = old.count_date and currency = 'LBP' and note like 'Cash count — %';
  else
    update public.cash_differences set amount = total, note = 'Cash count — ' || what, updated_by = auth.uid()
     where cashier_id = old.cashier_id and day = old.count_date and currency = 'LBP' and note like 'Cash count — %';
  end if;
  return old;
end $$;
drop trigger if exists cash_counts_after_delete on public.cash_counts;
create trigger cash_counts_after_delete after delete on public.cash_counts for each row execute function public.cash_counts_after_delete();
