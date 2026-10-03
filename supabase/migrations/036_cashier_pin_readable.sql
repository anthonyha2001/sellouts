-- 036 — Cashier PINs can be looked up and exported (owner, 2026-10-03: "keep PINs readable").
-- The PIN is still checked against pin_hash (bcrypt) as before; a copy is kept in cashiers.pin, which is
-- NOT selectable by app users (cashiers has column-level grants, 005) — only cashier_pins() returns it,
-- to whoever may set PINs (cash.cashiers, schedule.manage). PINs set before this stay unreadable until
-- they are set again.
-- ADDITIVE (new column, set_cashier_pin replaced with the same checks, new function).

alter table public.cashiers add column if not exists pin text;
revoke select (pin) on public.cashiers from anon, authenticated;

create or replace function public.set_cashier_pin(p_cashier uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.has_perm('cash.cashiers', 'schedule.manage') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_pin is not null and p_pin !~ '^\d{4}$' then
    raise exception 'The PIN must be exactly 4 digits';
  end if;
  update public.cashiers
     set pin_hash = case when p_pin is null then null else crypt(p_pin, gen_salt('bf', 8)) end,
         pin = p_pin,
         failed_attempts = 0, locked_until = null
   where id = p_cashier;
  if not found then raise exception 'Cashier not found'; end if;
end $$;
revoke execute on function public.set_cashier_pin(uuid, text) from public, anon;
grant execute on function public.set_cashier_pin(uuid, text) to authenticated;

-- Every cashier's PIN (null = set before 036, or none), for the PIN list / export.
create or replace function public.cashier_pins()
returns table (id uuid, name text, pin text, has_pin boolean, active boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm('cash.cashiers', 'schedule.manage') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query select c.id, c.name, c.pin, c.has_pin, c.active from public.cashiers c order by c.sort_order, c.name;
end $$;
revoke execute on function public.cashier_pins() from public, anon;
grant execute on function public.cashier_pins() to authenticated;
