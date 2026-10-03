-- 038 — Cashiers change their own PIN on the cashier page; only the admin can see PINs (owner, 2026-10-03).
--   cashier_change_pin(): called by the cashier-view function (service key) after it checked the current
--     PIN (cashier_verify_pin, with its lock-out). Not callable from the app.
--   cashier_pins() (036): admin only now (was whoever may set PINs). The accountant / HR still set and
--     reset PINs (set_cashier_pin), they just can't list them.
-- ADDITIVE (new function; cashier_pins replaced with a stricter check).

create or replace function public.cashier_change_pin(p_cashier uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin is null or p_pin !~ '^\d{4}$' then raise exception 'The PIN must be exactly 4 digits'; end if;
  update public.cashiers
     set pin_hash = crypt(p_pin, gen_salt('bf', 8)), pin = p_pin, failed_attempts = 0, locked_until = null
   where id = p_cashier and active;
  if not found then raise exception 'Cashier not found'; end if;
end $$;
revoke all on function public.cashier_change_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.cashier_change_pin(uuid, text) to service_role;

create or replace function public.cashier_pins()
returns table (id uuid, name text, pin text, has_pin boolean, active boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_role('admin') then
    raise exception 'Only the admin can see the PINs' using errcode = '42501';
  end if;
  return query select c.id, c.name, c.pin, c.has_pin, c.active from public.cashiers c order by c.sort_order, c.name;
end $$;
revoke execute on function public.cashier_pins() from public, anon;
grant execute on function public.cashier_pins() to authenticated;
