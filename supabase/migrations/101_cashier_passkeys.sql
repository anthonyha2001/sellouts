-- 101 — Biometric login for cashiers (owner, 2026-10-25): a cashier signs in with their PIN, then unlocks with their
--   phone's Face ID / fingerprint / passcode (a WebAuthn passkey bound to their phone). Once a cashier has enrolled at
--   least one passkey, the PIN alone is NOT enough — the cashier-view function refuses PIN-only access and requires a
--   biometric assertion. So someone who only knows the PIN cannot enter the account from another phone.
--   Cashiers are not auth users, so everything is handled by the cashier-view function (service role); these tables are
--   service-role only. A lost/replaced phone is recovered by an admin with cashier_reset_biometric(). ADDITIVE.

create table if not exists public.cashier_passkeys (
  id            uuid primary key default gen_random_uuid(),
  cashier_id    uuid not null references public.cashiers(id) on delete cascade,
  credential_id text not null unique,                 -- base64url
  public_key    text not null,                        -- base64url (COSE key)
  counter       bigint not null default 0,
  transports    text,
  device_label  text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists cashier_passkeys_cashier on public.cashier_passkeys (cashier_id);
alter table public.cashier_passkeys enable row level security;
revoke all on public.cashier_passkeys from anon, authenticated;   -- cashier-view (service role) only

-- the one-time challenge of an in-progress register/auth ceremony (one per cashier per kind)
create table if not exists public.cashier_webauthn_challenges (
  cashier_id uuid not null references public.cashiers(id) on delete cascade,
  kind       text not null check (kind in ('register', 'auth')),
  challenge  text not null,
  created_at timestamptz not null default now(),
  primary key (cashier_id, kind)
);
alter table public.cashier_webauthn_challenges enable row level security;
revoke all on public.cashier_webauthn_challenges from anon, authenticated;

-- Admin recovery: wipe a cashier's passkeys (lost/replaced phone) so they fall back to PIN and can enroll again.
create or replace function public.cashier_reset_biometric(p_cashier uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_role('admin') then raise exception 'Admin only'; end if;
  delete from public.cashier_passkeys where cashier_id = p_cashier;
  delete from public.cashier_webauthn_challenges where cashier_id = p_cashier;
end $$;
revoke all on function public.cashier_reset_biometric(uuid) from public, anon;
grant execute on function public.cashier_reset_biometric(uuid) to authenticated;

-- Admin read: how many passkeys each active cashier has enrolled (for the admin screen; no key material exposed).
create or replace function public.cashier_biometric_status() returns jsonb
language plpgsql security definer set search_path = public as $$
declare res jsonb;
begin
  if not (public.is_role('admin') or public.has_perm(array['cash.view'])) then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('cashier_id', c.id, 'passkeys', (select count(*) from public.cashier_passkeys k where k.cashier_id = c.id)) order by c.name), '[]'::jsonb)
    into res from public.cashiers c where c.active;
  return res;
end $$;
revoke all on function public.cashier_biometric_status() from public, anon;
grant execute on function public.cashier_biometric_status() to authenticated;
