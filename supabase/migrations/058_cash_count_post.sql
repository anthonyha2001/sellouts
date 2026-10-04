-- 058 — Cash count to the Cash page, on the accountant's command (owner, 2026-10-04).
--   Missing slips are marked one by one (not_found = {"<card>#<n>": true}, n = the slip's place in card_items).
--   The difference after the allowed margin (1,000 per 1,000,000 of cash) of a reconciled count goes to the Cash
--   page (cash_differences, that cashier, that day, LBP) when the accountant presses "Send to the Cash page":
--   cash_count_post(count, amount) keeps the amount on the count (posted_amount / posted_at) and writes the
--   cashier's day as the sum of their sent counts. Refused when the month is locked on the Cash page.
-- ADDITIVE (new columns and function; the guard knows the new columns).

alter table public.cash_counts add column if not exists posted_amount numeric;
alter table public.cash_counts add column if not exists posted_at timestamptz;

create or replace function public.cash_count_post(p_count uuid, p_amount numeric) returns numeric
language plpgsql security definer set search_path = public as $$
declare c public.cash_counts; total numeric; what text;
begin
  if not public.has_perm('cashcount.reconcile') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into c from public.cash_counts where id = p_count;
  if c.id is null then raise exception 'Count not found'; end if;
  if c.reconciled_at is null then raise exception 'Reconcile the count first'; end if;
  if c.cashier_id is null then raise exception 'This count has no cashier'; end if;
  if public.cash_month_is_locked(c.count_date) then raise exception 'That month is locked on the Cash page' using errcode = '42501'; end if;
  update public.cash_counts set posted_amount = round(coalesce(p_amount, 0)), posted_at = now() where id = p_count;
  select sum(posted_amount), string_agg('POS ' || pos || ' ' || upper(shift) || ': ' || to_char(posted_amount, 'FM999,999,999,990'), ', ' order by pos)
    into total, what
    from public.cash_counts where cashier_id = c.cashier_id and count_date = c.count_date and posted_at is not null;
  insert into public.cash_differences (cashier_id, day, currency, amount, note)
  values (c.cashier_id, c.count_date, 'LBP', total, 'Cash count — ' || what)
  on conflict (cashier_id, day, currency) do update set amount = excluded.amount, note = excluded.note, updated_by = auth.uid();
  return total;
end $$;
revoke execute on function public.cash_count_post(uuid, numeric) from public, anon;
grant execute on function public.cash_count_post(uuid, numeric) to authenticated;

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
  part1 := (new.lbp, new.usd, new.cards, new.expenses, new.card_items, new.expense_items, new.pos, new.shift, new.cashier_id, new.cashier_name, new.count_date)
           is distinct from (old.lbp, old.usd, old.cards, old.expenses, old.card_items, old.expense_items, old.pos, old.shift, old.cashier_id, old.cashier_name, old.count_date);
  part2 := (new.system, new.not_found, new.usd_rate, new.reconciled_at, new.posted_amount, new.posted_at) is distinct from (old.system, old.not_found, old.usd_rate, old.reconciled_at, old.posted_amount, old.posted_at);
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
