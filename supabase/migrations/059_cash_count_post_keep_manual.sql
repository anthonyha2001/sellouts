-- 059 — Cash count to the Cash page: never overwrite a difference typed by hand (owner, 2026-10-04).
--   cash_count_post() (058) writes the cashier's day on the Cash page. When that day already has an LBP
--   difference that did not come from the cash count (its note does not start with "Cash count — "),
--   the send is refused, so nothing entered by hand is replaced.
-- ADDITIVE (the function is replaced with the extra check; nothing else changes).

create or replace function public.cash_count_post(p_count uuid, p_amount numeric) returns numeric
language plpgsql security definer set search_path = public as $$
declare c public.cash_counts; total numeric; what text; prev text; has_prev boolean;
begin
  if not public.has_perm('cashcount.reconcile') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into c from public.cash_counts where id = p_count;
  if c.id is null then raise exception 'Count not found'; end if;
  if c.reconciled_at is null then raise exception 'Reconcile the count first'; end if;
  if c.cashier_id is null then raise exception 'This count has no cashier'; end if;
  if public.cash_month_is_locked(c.count_date) then raise exception 'That month is locked on the Cash page' using errcode = '42501'; end if;
  select true, note into has_prev, prev from public.cash_differences where cashier_id = c.cashier_id and day = c.count_date and currency = 'LBP';
  if coalesce(has_prev, false) and coalesce(prev, '') not like 'Cash count — %' then
    raise exception 'The Cash page already has an LBP difference for % on that day, entered by hand: change it there', c.cashier_name;
  end if;
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
