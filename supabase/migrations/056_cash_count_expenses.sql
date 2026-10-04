-- 056 — Cash count: expenses (owner, 2026-10-04). Cash the cashier paid out of the drawer (with a receipt): the
-- system does not know them, so they are added to the counted cash before comparing. LBP and USD, and a note.
-- Part of the count (part 1): signed by the cashier with the rest. ADDITIVE (new column; the guard knows it).

alter table public.cash_counts add column if not exists expenses jsonb not null default '{}';   -- {"lbp": 150000, "usd": 0, "note": "Water"}

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
  part1 := (new.lbp, new.usd, new.cards, new.expenses, new.pos, new.shift, new.cashier_id, new.cashier_name, new.count_date)
           is distinct from (old.lbp, old.usd, old.cards, old.expenses, old.pos, old.shift, old.cashier_id, old.cashier_name, old.count_date);
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
