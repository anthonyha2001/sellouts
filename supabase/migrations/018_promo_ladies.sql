-- 018 — Promo ladies (owner, 2026-09-30): in-store promoters booked by suppliers.
-- Each booking: supplier (from Vendors), paid or free (amount when paid), the item promoted, the dates.
-- Access: permission 'promoladies.manage' — admin and floor manager by default (Users → Permissions for others).
-- ADDITIVE: a new table + the permission.

insert into public.permissions (key, grp, label, sort) values ('promoladies.manage', 'Promo ladies', 'See and manage promo ladies', 33)
on conflict (key) do nothing;
insert into public.role_permissions (role, perm) values ('floor_manager', 'promoladies.manage') on conflict do nothing;

create table if not exists public.promo_ladies (
  id          uuid primary key default gen_random_uuid(),
  supplier    text not null check (length(trim(supplier)) > 0),
  paid        boolean not null default false,
  amount      numeric check (amount is null or amount >= 0),      -- USD, when paid
  item        text not null default '',                          -- what is promoted
  start_date  date not null,
  end_date    date not null,
  note        text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_date >= start_date),
  check (paid or amount is null or amount = 0)
);
create index if not exists promo_ladies_dates_idx on public.promo_ladies (start_date, end_date);

alter table public.promo_ladies enable row level security;
revoke all on public.promo_ladies from anon;
revoke truncate, references, trigger on public.promo_ladies from authenticated;
drop policy if exists promo_ladies_all on public.promo_ladies;
create policy promo_ladies_all on public.promo_ladies for all to authenticated
  using (public.has_perm('promoladies.manage')) with check (public.has_perm('promoladies.manage'));
