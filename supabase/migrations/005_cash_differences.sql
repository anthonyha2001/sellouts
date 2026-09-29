-- 005 — Cash differences, cashiers with PINs, month locks, settings (PLAN §8.1).
-- New tables only. Currency: USD (owner, 2026-09-29); the currency column stays so LBP could be
-- added later. Old LBP sheets are converted on import; the original amount and rate are kept.
-- Access: admin + accountant only. The public cashier page never touches these tables directly;
-- it goes through the cashier-view edge function, which calls cashier_verify_pin().

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.cashiers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) > 0),
  active          boolean not null default true,
  sort_order      integer not null default 0,
  pin_hash        text,                                   -- bcrypt; never readable by app users
  has_pin         boolean generated always as (pin_hash is not null) stored,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists cashiers_name_key on public.cashiers (lower(trim(name)));

create table if not exists public.cash_differences (
  id              uuid primary key default gen_random_uuid(),
  cashier_id      uuid not null references public.cashiers on delete restrict,
  day             date not null,
  amount          numeric(14,2) not null,                 -- negative = short, positive = over
  currency        text not null default 'USD' check (currency in ('USD', 'LBP')),
  note            text,
  source_amount   numeric,                                -- e.g. the LBP figure an imported USD amount came from
  source_currency text,
  source_rate     numeric,
  created_by      uuid default auth.uid(),
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (cashier_id, day, currency)
);
create index if not exists cash_differences_day_idx on public.cash_differences (day);

create table if not exists public.cash_months (
  month     text primary key check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  locked    boolean not null default false,
  locked_by uuid,
  locked_at timestamptz
);

create table if not exists public.cash_settings (
  id                 text primary key default 'app' check (id = 'app'),
  currency           text not null default 'USD',
  warning_threshold  numeric not null default 10,   -- |difference| >= this: orange
  danger_threshold   numeric not null default 20,   -- |difference| >= this: red
  alert_short_count  integer not null default 3,    -- shortages beyond the warning level in a month
  alert_short_streak integer not null default 3,    -- short this many days in a row
  reminder_hour      integer not null default 12 check (reminder_hour between 0 and 23),  -- Beirut hour
  updated_by         uuid,
  updated_at         timestamptz not null default now()
);
insert into public.cash_settings (id) values ('app') on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
-- Stamp who/when on every change.
create or replace function public.cash_differences_stamp() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists cash_differences_stamp on public.cash_differences;
create trigger cash_differences_stamp before insert or update on public.cash_differences
  for each row execute function public.cash_differences_stamp();

-- No writes into a locked month (checks the old and the new day).
create or replace function public.cash_month_is_locked(d date) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select locked from public.cash_months where month = to_char(d, 'YYYY-MM')), false)
$$;
create or replace function public.cash_differences_lock_guard() returns trigger
language plpgsql as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and public.cash_month_is_locked(old.day) then
    raise exception 'The month % is locked', to_char(old.day, 'YYYY-MM') using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and public.cash_month_is_locked(new.day) then
    raise exception 'The month % is locked', to_char(new.day, 'YYYY-MM') using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists cash_differences_lock_guard on public.cash_differences;
create trigger cash_differences_lock_guard before insert or update or delete on public.cash_differences
  for each row execute function public.cash_differences_lock_guard();

-- Locking: admin or accountant. Unlocking: admin only.
create or replace function public.cash_months_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then
    if tg_op = 'UPDATE' and old.locked and not new.locked and not public.is_role('admin') then
      raise exception 'Only an admin can unlock a month' using errcode = '42501';
    end if;
    if tg_op = 'DELETE' and old.locked and not public.is_role('admin') then
      raise exception 'Only an admin can unlock a month' using errcode = '42501';
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      if new.locked and (tg_op = 'INSERT' or not old.locked) then
        new.locked_by := auth.uid(); new.locked_at := now();
      elsif not new.locked then
        new.locked_by := null; new.locked_at := null;
      end if;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists cash_months_guard on public.cash_months;
create trigger cash_months_guard before insert or update or delete on public.cash_months
  for each row execute function public.cash_months_guard();

create or replace function public.cash_settings_stamp() returns trigger
language plpgsql as $$
begin
  new.updated_by := auth.uid(); new.updated_at := now();
  if new.warning_threshold < 0 or new.danger_threshold < new.warning_threshold then
    raise exception 'The red level must be at or above the orange level';
  end if;
  return new;
end $$;
drop trigger if exists cash_settings_stamp on public.cash_settings;
create trigger cash_settings_stamp before update on public.cash_settings
  for each row execute function public.cash_settings_stamp();

-- ---------------------------------------------------------------------------
-- PINs (4 digits, bcrypt). Set by admin/accountant; checked only by the edge function.
-- ---------------------------------------------------------------------------
create or replace function public.set_cashier_pin(p_cashier uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_role('admin', 'accountant') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_pin is not null and p_pin !~ '^\d{4}$' then
    raise exception 'The PIN must be exactly 4 digits';
  end if;
  update public.cashiers
     set pin_hash = case when p_pin is null then null else crypt(p_pin, gen_salt('bf', 8)) end,
         failed_attempts = 0, locked_until = null
   where id = p_cashier;
  if not found then raise exception 'Cashier not found'; end if;
end $$;
revoke execute on function public.set_cashier_pin(uuid, text) from public, anon;
grant execute on function public.set_cashier_pin(uuid, text) to authenticated;

-- 'ok' | 'wrong' | 'locked' | 'no_pin' | 'unknown'. 5 wrong PINs -> locked for 15 minutes.
create or replace function public.cashier_verify_pin(p_cashier uuid, p_pin text)
returns table (status text, locked_until timestamptz, attempts_left integer)
language plpgsql security definer set search_path = public, extensions as $$
declare c public.cashiers%rowtype; n integer;
begin
  select * into c from public.cashiers where id = p_cashier and active for update;
  if not found then return query select 'unknown'::text, null::timestamptz, null::integer; return; end if;
  if c.locked_until is not null and c.locked_until > now() then
    return query select 'locked'::text, c.locked_until, 0; return;
  end if;
  if c.pin_hash is null then return query select 'no_pin'::text, null::timestamptz, null::integer; return; end if;
  if p_pin ~ '^\d{4}$' and c.pin_hash = crypt(p_pin, c.pin_hash) then
    update public.cashiers set failed_attempts = 0, locked_until = null where id = c.id;
    return query select 'ok'::text, null::timestamptz, null::integer; return;
  end if;
  n := c.failed_attempts + 1;
  if n >= 5 then
    update public.cashiers set failed_attempts = 0, locked_until = now() + interval '15 minutes' where id = c.id;
    return query select 'locked'::text, now() + interval '15 minutes', 0;
  else
    update public.cashiers set failed_attempts = n, locked_until = null where id = c.id;
    return query select 'wrong'::text, null::timestamptz, 5 - n;
  end if;
end $$;
revoke execute on function public.cashier_verify_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.cashier_verify_pin(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Access: admin + accountant. anon: nothing. pin_hash is never selectable.
-- ---------------------------------------------------------------------------
alter table public.cashiers         enable row level security;
alter table public.cash_differences enable row level security;
alter table public.cash_months      enable row level security;
alter table public.cash_settings    enable row level security;

revoke all on public.cashiers, public.cash_differences, public.cash_months, public.cash_settings from anon;
revoke all on public.cashiers from authenticated;
grant select (id, name, active, sort_order, has_pin, failed_attempts, locked_until, created_at) on public.cashiers to authenticated;
grant insert (name, active, sort_order) on public.cashiers to authenticated;
grant update (name, active, sort_order, failed_attempts, locked_until) on public.cashiers to authenticated;
revoke truncate, references, trigger on public.cash_differences, public.cash_months, public.cash_settings from authenticated;
revoke insert, delete on public.cash_settings from authenticated;

create policy cashiers_staff on public.cashiers for all to authenticated
  using (public.is_role('admin', 'accountant')) with check (public.is_role('admin', 'accountant'));
create policy cash_differences_staff on public.cash_differences for all to authenticated
  using (public.is_role('admin', 'accountant')) with check (public.is_role('admin', 'accountant'));
create policy cash_months_staff on public.cash_months for all to authenticated
  using (public.is_role('admin', 'accountant')) with check (public.is_role('admin', 'accountant'));
create policy cash_settings_staff on public.cash_settings for all to authenticated
  using (public.is_role('admin', 'accountant')) with check (public.is_role('admin', 'accountant'));
