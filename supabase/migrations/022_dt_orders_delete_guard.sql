-- 022 — Deleting delivery orders follows the same rule as editing them (owner, 2026-10-01).
-- The dt_orders policy lets any signed-in user write; dt_orders_guard already limits INSERT and
-- UPDATE. This adds the DELETE side:
--   delivery.manage  -> any order
--   delivery.orders  -> only orders dated today (Beirut)
--   anyone else      -> refused
-- Server-side jobs (no signed-in user) are not limited. ADDITIVE.

create or replace function public.dt_orders_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return old; end if;
  if public.has_perm('delivery.manage') then return old; end if;
  if public.has_perm('delivery.orders') and old.order_date = public.beirut_today() then return old; end if;
  raise exception 'Only orders dated today (%) can be deleted', public.beirut_today()
    using errcode = '42501';
end $$;

drop trigger if exists dt_orders_delete_guard on public.dt_orders;
create trigger dt_orders_delete_guard before delete on public.dt_orders
  for each row execute function public.dt_orders_delete_guard();
