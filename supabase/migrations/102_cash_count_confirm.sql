-- 102 — Cash-count confirmation on the cashier's own phone (owner, 2026-10-25): instead of handing the device over for a
--   PIN, the office (or the supervisor's blind count) REQUESTS the cashier's signature; the cashier opens the count on
--   their own phone (by push, or by scanning a QR shown on the counting device), reviews what was counted ONCE, and
--   confirms with Face ID / fingerprint (PIN still works as a fallback). ADDITIVE.
alter table public.cash_counts
  add column if not exists sign_requested_at timestamptz,
  add column if not exists sign_requested_by uuid,
  add column if not exists sign_method       text,          -- 'biometric' | 'pin'
  add column if not exists signed_viewed_at   timestamptz;   -- when the cashier first opened the amounts to confirm (view-once)

-- Office / supervisor asks the cashier to confirm. Returns the cashier so the page can show the QR / push target.
create or replace function public.cash_count_request_sign(p_count uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.cash_counts;
begin
  if not public.has_perm('cashcount.count', 'cashcount.reconcile') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into c from public.cash_counts where id = p_count;
  if c.id is null then raise exception 'That count was not found'; end if;
  if c.cashier_id is null then raise exception 'This count has no cashier to sign it'; end if;
  if c.signed_at is not null then return jsonb_build_object('already_signed', true, 'cashier_id', c.cashier_id); end if;
  update public.cash_counts set sign_requested_at = now(), sign_requested_by = auth.uid() where id = p_count;
  return jsonb_build_object('ok', true, 'cashier_id', c.cashier_id);
end $$;
revoke all on function public.cash_count_request_sign(uuid) from public, anon;
grant execute on function public.cash_count_request_sign(uuid) to authenticated;

-- The cashier signs (service role only — called by the cashier-view function AFTER it verified the biometric or the PIN).
-- auth.uid() is null for the service role, so the cash_counts guard accepts the signature (it also sets the flag, belt and braces).
create or replace function public.cash_count_sign_cashier(p_count uuid, p_cashier uuid, p_method text) returns text
language plpgsql security definer set search_path = public as $$
declare c public.cash_counts;
begin
  select * into c from public.cash_counts where id = p_count;
  if c.id is null or c.cashier_id is null then return 'no_cashier'; end if;
  if c.cashier_id <> p_cashier then return 'mismatch'; end if;
  if c.signed_at is not null then return 'ok'; end if;
  perform set_config('lv.cash_count_signing', '1', true);
  update public.cash_counts set signed_at = now(), sign_method = case when p_method = 'pin' then 'pin' else 'biometric' end where id = p_count;
  perform set_config('lv.cash_count_signing', '', true);
  return 'ok';
end $$;
revoke all on function public.cash_count_sign_cashier(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cash_count_sign_cashier(uuid, uuid, text) to service_role;

-- Stamp the first time the cashier opened the amounts (view-once bookkeeping); service role only.
create or replace function public.cash_count_mark_viewed(p_count uuid, p_cashier uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.cash_counts set signed_viewed_at = coalesce(signed_viewed_at, now())
    where id = p_count and cashier_id = p_cashier and signed_viewed_at is null;
end $$;
revoke all on function public.cash_count_mark_viewed(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cash_count_mark_viewed(uuid, uuid) to service_role;
