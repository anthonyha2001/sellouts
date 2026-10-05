-- 061 — Cash count from the cashier page, by the cashier supervisors, blind (owner, 2026-10-05).
--   A supervisor (cashiers.position = 'supervisor', signed in on the cashier page with their PIN) counts a drawer
--   on their phone: POS, shift, cashier, date (today or yesterday), the bills, the slips one by one, the
--   expenses. No total is shown to them, and once sent the count is gone from their phone: they never read it back.
--   The cashier signs with their own PIN on the same phone, or later in the office (the app's Cash count page).
--   cash_count_from_page() is called only by the cashier-view function (service role), after it checked the
--   supervisor's PIN. It checks every value, works out the totals, and writes the count.
--   Returns 'ok' | 'exists' (that POS and shift is already counted that day) | the cashier PIN's status
--   ('wrong:<tries left>', 'locked', 'no_pin').
--   POS / shifts already counted (today and yesterday, no amounts): cash_count_taken().
-- ADDITIVE (two new functions, service role only).

create or replace function public.cash_count_from_page(p_sup uuid, p_count jsonb, p_cashier_pin text default null) returns text
language plpgsql security definer set search_path = public as $$
declare
  sup public.cashiers; who public.cashiers; r record;
  today date := (now() at time zone 'Asia/Beirut')::date; d date; p_pos int; p_shift text;
  lbp jsonb := '{}'; usd jsonb := '{}'; items jsonb := '[]'; exps jsonb := '[]'; cards jsonb := '{}';
  e_lbp numeric := 0; e_usd numeric := 0; e_note text := '';
  el jsonb; k text; v text; amt numeric; t text; cur text; signed timestamptz;
  kinds text[] := array['visa_bankmed', 'master_bankmed', 'areeba', 'ccm_master', 'ccm_visa', 'on_account', 'amex', 'voucher', 'points'];
begin
  select * into sup from public.cashiers where id = p_sup;
  if sup.id is null or not sup.active or sup.position <> 'supervisor' then raise exception 'Only the cashier supervisors can count a drawer here'; end if;
  begin who := null; select * into who from public.cashiers where id = (p_count->>'cashier_id')::uuid; exception when others then who := null; end;
  if who.id is null or not who.active then raise exception 'Choose the cashier'; end if;
  begin d := (p_count->>'count_date')::date; exception when others then d := null; end;
  if d is null or d not in (today, today - 1) then raise exception 'The date must be today or yesterday'; end if;
  p_pos := case when (p_count->>'pos') ~ '^[1-8]$' then (p_count->>'pos')::int end;
  p_shift := p_count->>'shift';
  if p_pos is null then raise exception 'Choose the POS'; end if;
  if p_shift is null or p_shift not in ('am', 'pm', 'full') then raise exception 'Choose the shift'; end if;
  if exists (select 1 from public.cash_counts where count_date = d and pos = p_pos and shift = p_shift) then return 'exists'; end if;

  -- bills: how many of each
  for k, v in select key, value from jsonb_each_text(coalesce(p_count->'lbp', '{}')) loop
    if k in ('100000', '50000', '20000', '10000', '5000', '1000') and v ~ '^\d{1,5}$' and v::int > 0 then lbp := lbp || jsonb_build_object(k, v::int); end if;
  end loop;
  for k, v in select key, value from jsonb_each_text(coalesce(p_count->'usd', '{}')) loop
    if k in ('100', '50', '20', '10', '5', '1') and v ~ '^\d{1,5}$' and v::int > 0 then usd := usd || jsonb_build_object(k, v::int); end if;
  end loop;
  -- slips, one by one, and their totals per card
  for el in select value from jsonb_array_elements(case when jsonb_typeof(p_count->'card_items') = 'array' then p_count->'card_items' else '[]' end) limit 400 loop
    t := el->>'type'; cur := el->>'cur'; v := el->>'amount';
    if t = any(kinds) and cur in ('lbp', 'usd') and v ~ '^\d{1,12}(\.\d{1,2})?$' and v::numeric > 0 then
      amt := v::numeric;
      items := items || jsonb_build_array(jsonb_build_object('type', t, 'cur', cur, 'amount', amt));
      cards := jsonb_set(cards, array[t], coalesce(cards->t, '{"lbp": 0, "usd": 0}'::jsonb)
        || jsonb_build_object(cur, coalesce((cards->t->>cur)::numeric, 0) + amt));
    end if;
  end loop;
  -- expenses paid from the drawer
  for el in select value from jsonb_array_elements(case when jsonb_typeof(p_count->'expense_items') = 'array' then p_count->'expense_items' else '[]' end) limit 100 loop
    cur := el->>'cur'; v := el->>'amount';
    if cur in ('lbp', 'usd') and v ~ '^\d{1,12}(\.\d{1,2})?$' and v::numeric > 0 then
      amt := v::numeric;
      exps := exps || jsonb_build_array(jsonb_build_object('cur', cur, 'amount', amt, 'note', left(coalesce(el->>'note', ''), 120)));
      if cur = 'lbp' then e_lbp := e_lbp + amt; else e_usd := e_usd + amt; end if;
      if coalesce(el->>'note', '') <> '' then e_note := e_note || case when e_note = '' then '' else ', ' end || left(el->>'note', 120); end if;
    end if;
  end loop;

  -- the cashier signs now (their own PIN, same check and lock-out as everywhere), or later in the office
  if coalesce(p_cashier_pin, '') <> '' then
    select * into r from public.cashier_verify_pin(who.id, p_cashier_pin);
    if r.status <> 'ok' then return r.status || coalesce(':' || r.attempts_left, ''); end if;
    signed := now();
  end if;

  insert into public.cash_counts (count_date, pos, shift, cashier_id, cashier_name, lbp, usd, cards, card_items,
    expenses, expense_items, usd_rate, counted_by_name, signed_at, note)
  values (d, p_pos, p_shift, who.id, who.name, lbp, usd, cards, items,
    jsonb_build_object('lbp', e_lbp, 'usd', e_usd, 'note', e_note), exps,
    (select usd_rate from public.cash_settings where id = 'app'), sup.name, signed, 'Counted on the cashier page');
  return 'ok';
end $$;
revoke execute on function public.cash_count_from_page(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.cash_count_from_page(uuid, jsonb, text) to service_role;

-- What is already counted (no amounts): so a supervisor does not count the same POS and shift twice.
create or replace function public.cash_count_taken() returns table (count_date date, pos int, shift text)
language sql stable security definer set search_path = public as $$
  select count_date, pos, shift from public.cash_counts
   where count_date >= (now() at time zone 'Asia/Beirut')::date - 1
$$;
revoke execute on function public.cash_count_taken() from public, anon, authenticated;
grant execute on function public.cash_count_taken() to service_role;
